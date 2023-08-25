import express from 'express';
import expressWs from 'express-ws';
import { v4 } from 'uuid'
import { methods } from "./fs"

const app = expressWs(express()).app
app.enable("trust proxy")
app.locals.title = "CC Remote Mount"
app.locals.url = "localhost:4000"

if (!(process.argv[2] && process.argv[3])) {
    throw new Error("Missing username and password parameters")
}

const duration = 1000 * 60 * 10;
class Token {
    readonly uuid: string;
    private expired: boolean;
    private isConnected: boolean;

    matches(comp: string) {
        return (!this.expired || this.isConnected) && comp === this.uuid;
    }

    connect() {
        this.isConnected = true
    }

    disconnect() {
        this.isConnected = false
        this.expired = true
    }

    constructor() {
        this.isConnected = false;
        this.expired = false;
        this.uuid = v4();
        setTimeout(() => {
            this.expired = true;
        }, duration)
    }
}

let token: Token;

app.get('/', async (req, res) => {
    // authentication middleware
    // From https://stackoverflow.com/questions/23616371/basic-http-authentication-with-node-and-express-4
    
    const auth = {login: process.argv[2], password: process.argv[3]} // change this
  
    // parse login and password from headers
    const b64auth = (req.headers.authorization || '').split(' ')[1] || ''
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')
  
    // Verify login and password are set and correct
    if (login && password && login === auth.login && password === auth.password) {
        // Access granted...
        token = new Token();
        res.status(200).type('application/json').send(JSON.stringify({
            uuid: token.uuid
        }))
        return
    }
    // Access denied...
    res.set('WWW-Authenticate', 'Basic realm="ccmount"') // change this
    res.status(401).send('Authentication required.') // custom message
});

app.ws('/:uuid', async (ws, req) => {
    if (token && token.matches(req.params.uuid)) {
        ws.on("message", async (data, binary) => {
            token.connect()
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
                    console.log("input: ", content)
                    const out = JSON.stringify(await method(content))
                    console.log("output: ", out)
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
                    error: "Invalid JSON syntax"
                }))
            }
        })
        ws.on("close", async (data, binary) => {
            token.disconnect()
        })
    } else {
        ws.close(1003, 'Authentication required.')
    }
})

app.listen(process.argv[4] || 4000)