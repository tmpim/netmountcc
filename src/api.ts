import { Request, Response } from "express";
import fsp from 'fs/promises';
import { Config } from "./userlist";
import { debug } from "./util";
import { userlist } from "./userlist";

type Callback = (req: Request, res: Response) => void
export const api: Map<string, Map<string, Callback>> = new Map()

// Start doing stuff with the API
const user: Map<string, Callback> = new Map()

user.set("add", async (req, res) => {
    if (req.method === 'POST') {
        if (req.body.username && req.body.password) {
            await userlist.addUser(req.body.username, req.body.password, Config.restore(req.body.config))
            try {
                await userlist.flush()
                res.send({
                    ok: true
                })
            } catch (e) {
                res.send({
                    ok: false,
                    err: e
                })
            }
        } else {
            res.send({
                ok: false,
                err: "Expected username"
            })
        }
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

user.set("modify", async (req, res) => {
    if (req.method === 'POST') {
        if (req.body.username) {
            const target = userlist.getUserByName(req.body.username)
            if (target) {
                target.config = Config.restore(req.body.config)
                try {
                    await userlist.flush()
                    res.send({
                        ok: true
                    })
                } catch (e) {
                    res.send({
                        ok: false,
                        err: e
                    })
                }
            } else {
                res.send({
                    ok: false,
                    err: `No such user: ${req.body.username}`
                })
            }
        } else {
            res.send({
                ok: false,
                err: "Expected username"
            })
        }
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

user.set("remove", async (req, res) => {
    if (req.method === 'POST') {
        const deluser = userlist.getUserByName(req.body.username)
        if (deluser) {
            userlist.removeUser(deluser)
            try {
                await userlist.flush()
                res.send({
                    ok: true
                })
            } catch (e) {
                res.send({
                    ok: false,
                    err: e
                })
            }
        } else {
            res.send({
                ok: false,
                err: `No such user: ${req.body.username}`
            })
        }
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

user.set("get", async (req, res) => {
    if (req.method === 'GET') {
        const target = userlist.getUserByName(req.body.username)
        if (target) {
            res.send({
                ok: true,
                user: target.asObject()
            })
        } else {
            res.send({
                ok: false,
                err: `No such user: ${req.body.username}`
            })
        }
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

user.set("list", (req, res) => {
    if (req.method === 'GET') {
        res.send({
            ok: true,
            users: userlist.asObject().users
        })
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

api.set("user", user)

const drive: Map<string, Callback> = new Map()

drive.set("capacity", async (req, res) => {
    if (req.method === 'GET') {
        const stats = await fsp.statfs(userlist.getPath());
        res.send({
            ok: true,
            capacity: [ stats.bfree * stats.bsize, stats.blocks * stats.bsize ]
        })
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

api.set("drive", drive)

const reserve: Map<string, Callback> = new Map()

reserve.set("ws", async (req, res) => {
    if (req.method === 'GET') {
        res.send({
            ok: true,
            uuid: userlist.getFreeUUID()
        })
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

reserve.set("stream", async (req, res) => {
    if (req.method === 'GET') {
        
        res.send({
            ok: false,
            err: "Not Yet Implemented!"
        })
    } else {
        res.send({
            ok: false,
            err: "Incorrect Method"
        })
    }
})

api.set("reserve", reserve)
