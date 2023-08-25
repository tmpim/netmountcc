import express from 'express';
import expressWs from 'express-ws';
import path from 'path';
import 'dotenv/config'
import { methods } from "./fs"

const app = expressWs(express()).app
app.enable("trust proxy")

const luaPath = path.join(__dirname, "../public/mount.lua")
app.get('/mount.lua', async (req, res) => {
    res.status(200).type('text/plain').sendFile(luaPath)
})

app.ws('/', async (ws, req) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || ''
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')
    if (login && password && login === process.env.USERNAME && password === process.env.PASSWORD) {
        ws.send(JSON.stringify({
            ok: true,
            data: "hello"
        }))
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
                    // console.log("in: ", data)
                    const out = JSON.stringify(await method(content))
                    // console.log("out: ", out)
                    ws.send(out)
                } else {
                    ws.send(JSON.stringify({
                        ok: false,
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
    } else {
        ws.close(1003, 'Authentication required.')
    }
})

app.listen(process.argv[4] || 4000)