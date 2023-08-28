import { v4 } from 'uuid'
import fsp from 'fs/promises';
import pathlib from 'path';
import {WebSocket, RawData} from 'ws'

function debug(message?: any, ...optionalParams: any[]) {
    if (process.env.DEBUG) {
        console.log(message, ...optionalParams)
    }
}

const chunkSize = Math.pow(2, 16);

class Stream {
    readonly uuid: string;
    protected readonly path: string;
    protected readonly ws: WebSocket;

    constructor(uuid: string, path: string, ws: WebSocket) {
        this.uuid = uuid
        this.path = path;
        this.ws = ws;
    }
}

export class ReadStream extends Stream {

    async run() {
        const data = btoa(await fsp.readFile(this.path, { encoding: 'binary'}))
        const listener = (rawdata: RawData, binary: boolean) => {
            const res = JSON.parse(rawdata.toString())
            if (res.type == "readStream" && res.uuid == this.uuid) {
                send(res.chunk)
            }
        }
        const send = (chunk: number) => {
            const subchunk = data?.substring(chunkSize * chunk, (chunkSize * (chunk + 1)) + 1)
            debug(subchunk)
            if (subchunk.length > 0) {
                this.ws.send(JSON.stringify({
                    ok: true,
                    type: "readStream",
                    uuid: this.uuid,
                    data: subchunk,
                    chunk
                }))
                debug(`sent chunk ${chunk}`)
            } else {
                this.ws.send(JSON.stringify({
                    ok: true,
                    type: "readStream",
                    uuid: this.uuid,
                    complete: true
                }))
                debug(`sending complete`)
                this.ws.removeListener("message", listener)
            }
        }
        this.ws.on("message", listener)
        send(0)
    }

    constructor(path: string, ws: WebSocket) {
        super(v4(), path, ws)
        this.ws.send(JSON.stringify({
            ok: true,
            type: "readFile",
            data: {
                uuid: this.uuid
            }
        }))
        this.run()
    }
}

export class WriteStream extends Stream {

    async run() {
        let data = "";
        const listener = async (wsdata: RawData, binary: boolean) => {
            const res = JSON.parse(wsdata.toString())
            if (res.type == "writeStream" && res.uuid == this.uuid && res.chunk >= 0) {
                debug(`got chunk ${res.chunk}`)
                data += res.data
                this.ws.send(JSON.stringify({
                    ok: true,
                    type: res.type,
                    uuid: this.uuid,
                    chunk: res.chunk+1
                }))
            } else if (res.complete) {
                this.ws.removeListener("message", listener)
                debug(`saving chunks`)
                await fsp.mkdir(pathlib.dirname(this.path), { recursive: true })
                debug(data)
                await fsp.writeFile(this.path, atob(data), { encoding: 'binary'})
            }
        }
        this.ws.on("message", listener)
    }

    constructor(uuid: string, path: string, ws: WebSocket) {
        super(uuid, path, ws)
        this.ws.send(JSON.stringify({
            ok: true,
            type: "writeFile",
            data: {
                uuid: this.uuid
            }
        }))
        this.run()
    }
}