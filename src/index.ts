import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import 'dotenv/config'
import { Attributes, methods, watch, getContents, getCapacity, setNetPath } from "./fs"

function debug(message?: any, ...optionalParams: any[]) {
    if (process.env.DEBUG) {
        console.log(message, optionalParams)
    }
}

const app = expressWs(express()).app
app.enable("trust proxy")

if (process.env.MPATH) {
    setNetPath(process.env.MPATH)
}

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

app.ws('/', async (ws, req) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || ''
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')
    if (login && password && login === process.env.USERNAME && password === process.env.PASSWORD) {
        // hello message
        ws.send(JSON.stringify({
            ok: true,
            type: "hello",
            data: {
                contents: getContents(),
                capacity: await getCapacity()
            }
        }, replacer))
        // file system watcher
        const closeListener = watch(async (path: string, attributes: false | Attributes) => {
            ws.send(JSON.stringify({
                ok: true,
                type: "sync",
                data: {
                    path,
                    attributes,
                    capacity: await getCapacity()
                }
            }))
        })
        // heartbeat
        setInterval(() => ws.ping(), 1000 * 20)
        // other message listener
        ws.on("message", async (data, binary) => {
            try {
                let content = JSON.parse(data.toString());
                if (!content.type) {
                    ws.send(JSON.stringify({
                        ok: false,
                        err: "Missing request type"
                    }))
                }
                const method = methods.get(content.type)
                if (method) {
                    debug("in: ", data)
                    const out = JSON.stringify(await method(content))
                    debug("out: ", out)
                    ws.send(out)
                } else if (content.type == "keepalive") {
                    // no-op
                } else {
                    ws.send(JSON.stringify({
                        ok: false,
                        type: content.type,
                        err: "No such request type '" + content.type + "'"
                    }))
                }
            } catch {
                ws.send(JSON.stringify({
                    ok: false,
                    err: "Invalid JSON syntax"
                }))
            }
        })
        ws.on("close", (code, reason) => {
            debug(code, reason)
            closeListener()
        })
    } else {
        ws.close(1003, 'Authentication required.')
    }
})

const port = process.env.PORT || 4000;
app.listen(port, () => {
    console.log("Netmount started on port " + port)
})