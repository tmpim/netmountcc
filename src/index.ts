import express from 'express';
import { WebSocketServer } from 'ws';
import path from 'path';
import 'dotenv/config'
import { v2 as webdav } from 'webdav-server'
import { debug } from './util';
import { CustomSimpleUserManager, PerUserFileSystem, UserListStorageManager } from './webdav';
import { api } from './api';
import { userlist } from "./userlist";
import { validate } from 'uuid';

const app = express()
app.enable("trust proxy")
app.use(express.json())

const files = ['mount.lua', 'api.lua']
files.forEach((file) => {
    const luaPath =  path.join(__dirname, "../public/", file)
    app.get('/' + file, async (req, res) => {
        res.status(200).type('text/plain').sendFile(luaPath)
    })
})

const webdavServer = new webdav.WebDAVServer({
    serverName: "netmount",
    requireAuthentification: true,
    httpAuthentication: new webdav.HTTPBasicAuthentication(new CustomSimpleUserManager(userlist), "netmount"),
    rootFileSystem: new PerUserFileSystem(userlist),
    privilegeManager: userlist.privelegeManager,
    storageManager: new UserListStorageManager(userlist)
})

webdavServer.beforeRequest((ctx, next) => {
    debug(`${new Date(Date.now()).toLocaleString()} "${ctx.request.method} ${ctx.request.url}"`)
    next()
})

if (process.env.WEBDAV_PORT) {
    webdavServer.start(Number(process.env.WEBDAV_PORT), () => {
        console.log("Netmount Webdav server started on port " + process.env.WEBDAV_PORT)
    })
} else {
    app.use(webdav.extensions.express('/webdav', webdavServer));
}

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (ws, req) => {
    ws.on('error', (err) => {
        let uuid = userlist.lookupUUID(ws)
        if (userlist.removeReservedUUID(ws)) {
            debug(`Freed UUID ${uuid} due to error`)
        }
        console.error(err)
    });
    ws.on('close', () => {
        let uuid = userlist.lookupUUID(ws)
        if (userlist.removeReservedUUID(ws)) {
            debug(`Freed UUID ${uuid}`)
        }
    })

    const user = userlist.authenticate(req.headers.authorization)
    if (user) {
        // heartbeat
        const beat = setInterval(() => {
            ws.ping()
        }, 1000 * 20)
        const clear = () => {
            clearInterval(beat)
        }
        ws.on("close", clear)
        ws.on("error", clear)

        // run netmount fs
        user.netfs.run(ws, req)
    } else {
        ws.close(1003, 'Authentication required')
    }
})

app.all("/api/:type/:action", (req, res) => {
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
    } else if (user) {
        if (req.params.type === "reserve") {
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
        }
    } else {
        res.setHeader("WWW-Authenticate", "Basic realm=netmount")
        res.status(401).send('Not Authorized');
    }
})

const port = process.env.PORT ? parseInt(process.env.PORT) : 4000;
const server = app.listen(port, () => {
    console.log("Netmount started on port " + port)
})

server.on('upgrade', (req, duplex, head) => {
    const { pathname } = new URL(req.url, `http://${req.headers.host}`);
    let uuid = pathname.replace(/^\//, "")
    if (validate(uuid)) {
        wss.handleUpgrade(req, duplex, head, (ws) => {
            if (userlist.reserveUUID(ws, uuid)) {
                debug(`Reserved UUID ${uuid}`)
                wss.emit("connection", ws, req)
            } else {
                ws.close(1003, "Connection ID Clash")
            }
        })
    } else {
        debug("used invalid uuid")
        wss.handleUpgrade(req, duplex, head, (ws) => {
            ws.close(1003, 'Invalid Connection ID')
        })
    }
})