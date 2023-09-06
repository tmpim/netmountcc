import { Request, Response } from "express";
import fsp from 'fs/promises';
import path from 'path';
import { Config, UserList } from "./userlist";

export let userlist: UserList;

type Callback = (req: Request, res: Response) => void
export const api: Map<string, Map<string, Callback>> = new Map()

if (process.env.USERNAME && process.env.PASSWORD) {
    userlist = new UserList()
    userlist.addUser(process.env.USERNAME, process.env.PASSWORD, new Config(undefined, process.env.PATH || path.join(__dirname, "../data")))
    // API not available in single user mode
} else if (process.env.USERLIST) {
    userlist = new UserList(process.env.USERLIST)

    // Start doing stuff with the API
    const user: Map<string, Callback> = new Map()
    
    user.set("add", async (req, res) => {
        if (req.method == 'POST' && req.body.username && req.body.password) {
            userlist.addUser(req.body.username, req.body.password, Config.restore(req.body.config))
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
                err: "Incorrect Method"
            })
        }
    })

    user.set("modify", async (req, res) => {
        if (req.method == 'POST' && req.body.username && req.body.password) {
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
                err: "Incorrect Method"
            })
        }
    })
    
    user.set("remove", async (req, res) => {
        if (req.method == 'POST') {
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
    
    user.set("list", (req, res) => {
        if (req.method == 'GET') {
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
        if (req.method == 'GET') {
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
}
