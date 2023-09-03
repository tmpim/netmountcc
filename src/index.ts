import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import 'dotenv/config'
import chokidar from 'chokidar'
import { v2 as webdav } from 'webdav-server'
import { UserList, Config } from './userlist';
import { PerUserFileSystem, UserListStorageManager } from './webdav'
import { debug } from './debug';

const app = expressWs(express()).app
app.enable("trust proxy")

const luaPath =  path.join(__dirname, "../public/mount.lua")
app.get('/mount.lua', async (req, res) => {
    res.status(200).type('text/plain').sendFile(luaPath)
})

let userlist: UserList = new UserList();
if (process.env.USERNAME && process.env.PASSWORD) {
    userlist.addUser(process.env.USERNAME, process.env.PASSWORD, new Config(undefined, process.env.PATH || path.join(__dirname, "../data")))
} else if (process.env.USERLIST) {
    let path: string = process.env.USERLIST;
    let update = async () => {
        try {
            userlist.fromJSON(path)
        } catch (e) {
            console.log(e)
        }
    }
    chokidar.watch(path).on("change", update).on("ready", update)
}

const server = new webdav.WebDAVServer({
    serverName: "netmount",
    requireAuthentification: true,
    httpAuthentication: new webdav.HTTPBasicAuthentication(userlist.usermanager, "netmount"),
    privilegeManager: userlist.privelegeManager,
    storageManager: new UserListStorageManager(userlist),
    rootFileSystem: new PerUserFileSystem(userlist)
})

app.use(webdav.extensions.express('/webdav', server));

app.ws('/', async (ws, req) => {
    const user = userlist.authenticate(req.headers.authorization)
    if (user) {
        // heartbeat
        const beat = setInterval(() => {
            ws.ping()
        }, 1000 * 20)
        ws.on("close", () => {
            clearInterval(beat)
        })

        // run netmount fs
        user.netfs.run(ws, req)
    } else {
        ws.close(1003, 'Authentication required.')
    }
})

const port = process.env.PORT ? parseInt(process.env.PORT) : 4000;
app.listen(port, () => {
    console.log("Netmount started on port " + port)
})