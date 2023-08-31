import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import 'dotenv/config'
import chokidar from 'chokidar'
import { Attributes, NetFS } from "./fs"
import { single, multi, UserList } from './userlist';

function debug(message?: any, ...optionalParams: any[]) {
    if (process.env.DEBUG) {
        console.log(message, ...optionalParams)
    }
}

const app = expressWs(express()).app
app.enable("trust proxy")

const luaPath =  path.join(__dirname, "../public/mount.lua")
app.get('/mount.lua', async (req, res) => {
    res.status(200).type('text/plain').sendFile(luaPath)
})

function replacer(key: any, value: any) {
    if(value instanceof Map) {
        return Object.fromEntries(value);
    } else {
        return value;
    }
}

let userlist: UserList;
if (process.env.USERNAME && process.env.PASSWORD) {
    single(process.env.USERNAME, process.env.PASSWORD).then((ulist) => {
        userlist = ulist
    })
} else if (process.env.USERLIST) {
    let path: string = process.env.USERLIST;
    multi(path).then((ulist) => {
        userlist = ulist
    })
    chokidar.watch(path).on("change", async () => {
        try {
            userlist = await multi(path)
        } catch (e) {
            console.log(e)
        }
    })
}


app.ws('/', async (ws, req) => {
    const user = userlist.authenticate(req.headers.authorization)
    if (user) {
        const fs = new NetFS(user, ws)
        const send = (data: object) => ws.send(JSON.stringify(data, replacer))
        let closeListener: () => void;
        debug("Connection established by ", req.ip)
        fs.run(async () => {
            // hello message
            send({
                ok: true,
                type: "hello",
                data: {
                    contents: fs.getContents(),
                    capacity: await fs.getCapacity()
                }
            })

            // file system watcher
            closeListener = fs.watch(async (path: string, attributes: false | Attributes) => {
                debug("sync", path, req.ip)
                send({
                    ok: true,
                    type: "sync",
                    data: {
                        path,
                        attributes,
                        capacity: await fs.getCapacity()
                    }
                })
            })
        })
        
        // heartbeat
        const beat = setInterval(() => {
            ws.ping()
        }, 1000 * 20)
        // other message listener
        ws.on("message", async (data, binary) => {
            try {
                let content = JSON.parse(data.toString());
                if (!content.type) {
                    send({
                        ok: false,
                        err: "Missing request type"
                    })
                    return
                }
                const method = fs.methods.get(content.type)
                if (method) {
                    debug("in: ", data)
                    let out;
                    try {
                        out = await method(content)
                    } catch (e) {
                        out = {
                            ok: false,
                            type: content.type,
                            err: e
                        }
                    }
                    debug("out: ", out)
                    if (out) {
                        send(out)
                    }
                } else {
                    send({
                        ok: false,
                        type: content.type,
                        err: "No such request type '" + content.type + "'"
                    })
                }
            } catch {
                // Could be a read/write stream blob. Just ignore.
            }
        })
        ws.on("close", (code, reason) => {
            debug(`Connection closed by ${req.ip}. ${code}: ${reason || "unknown"}`)
            clearInterval(beat)
            if (closeListener) {
                closeListener()
            }
        })
    } else {
        ws.close(1003, 'Authentication required.')
    }
})

const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.log("Netmount started on port " + port)
})