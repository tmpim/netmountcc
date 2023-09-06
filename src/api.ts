import { Request, Response } from "express";
import { Config, UserList } from "./userlist";
import path from 'path';

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
    
    user.set("add", (req, res) => {
        if (req.method == 'POST' && req.body.username && req.body.password) {
            userlist.addUser(req.body.username, req.body.password, Config.restore(req.body.config))
            res.send({
                ok: true
            })
        } else {
            res.send({
                ok: false,
                err: "Incorrect Method"
            })
        }
    })
    
    user.set("remove", (req, res) => {
        if (req.method == 'POST') {
            const deluser = userlist.getUserByName(req.body.username)
            if (deluser) {
                userlist.removeUser(deluser)
                res.send({
                    ok: true
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
}
