import express from 'express';
import expressWs from 'bun-express-ws';
import { wsIncomingMessage } from 'bun-express-ws/src/type';
import path from 'path';
import 'dotenv/config'
import { v2 as webdav } from 'webdav-server'
import { debug } from './util';
import { CustomSimpleUserManager, PerUserFileSystem, UserListStorageManager } from './webdav';
import { api, userlist } from './api';
import fsp from 'fs/promises';

const app = expressWs(express()).app
app.enable("trust proxy")
app.use(express.json())

const mountLuaFile = fsp.readFile(path.join(__dirname, "../public/mount.lua"))

const server = new webdav.WebDAVServer({
    serverName: "netmount",
    requireAuthentification: true,
    httpAuthentication: new webdav.HTTPBasicAuthentication(new CustomSimpleUserManager(userlist), "netmount"),
    rootFileSystem: new PerUserFileSystem(userlist),
    privilegeManager: userlist.privelegeManager,
    storageManager: new UserListStorageManager(userlist)
})

server.beforeRequest((ctx, next) => {
    debug(`${new Date(Date.now()).toLocaleString()} "${ctx.request.method} ${ctx.request.url}"`)
    next()
})

if (process.env.WEBDAV_PORT) {
    server.start(Number(process.env.WEBDAV_PORT), () => {
        console.log("Netmount Webdav server started on port " + process.env.WEBDAV_PORT)
    })
} else {
    app.use(webdav.extensions.express('/webdav', server));
}

app.ws('/', async (ws: WebSocket, req: wsIncomingMessage) => {
    const user = userlist.authenticate(req.headers.authorization)
    if (user) {
        // heartbeat
        const beat = setInterval(() => {
            ws.ping()
        }, 1000 * 20)
        ws.addEventListener("close", () => {
            clearInterval(beat)
        })
        // run netmount fs
        user.netfs.run(ws, req)
    } else {
        ws.close(1003, 'Authentication required.')
    }
})

app.all("/api/:type/:action", (req, res) => {
    debug("api request")
    const user = userlist.authenticate(req.headers.authorization)
    if (user && user.isAdministrator) {
        if (api.has(req.params.type)) {
            const type = api.get(req.params.type)
            if (type.has(req.params.action)) { 
                debug(`${user.username} requested ${req.params.type}.${req.params.action}`)
                res.status(200)
                type.get(req.params.action)(req, res)
            } else {
                res.status(200).send({
                    ok: false,
                    err: `No such request type ${req.params.action}`
                })
            }
        } else {
            res.status(200).send({
                ok: false,
                err: `No such request type ${req.params.type}`
            })
        }
    } else {
        res.setHeader("WWW-Authenticate", "Basic realm=netmount")
        res.status(401).send('Not Authorized');
    }
})

const port = process.env.PORT ? parseInt(process.env.PORT) : 4000;
app.listen(port, () => {
    console.log("Netmount started on port " + port)
})