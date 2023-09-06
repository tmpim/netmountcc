import pathlib from 'path';
import fsp from 'fs/promises';
import { IUser, SimplePathPrivilegeManager } from 'webdav-server/lib/index.v2';
import { NetFS } from './fs';
import { debug } from './util';

export class Config {
    readonly limit!: number
    readonly path!: string
    readonly isAdministrator!: boolean

    static restore(value: any) {
        if (value) {
            return new Config(value.limit, value.path, value.isAdministrator)
        } else {
            return new Config()
        }
    }
    
    asObject() {
        return {
            limit: this.limit,
            path: this.path,
            isAdministrator: this.isAdministrator
        }
    }

    constructor(limit?: number, path?: string, isAdministrator?: boolean) {
        if (limit) this.limit = limit
        if (path) this.path = path
        if (isAdministrator) this.isAdministrator = isAdministrator
    }
}

export class User implements IUser {
    readonly uid: string;
    readonly username: string;
    readonly password: string;
    readonly netfs: NetFS;
    readonly isDefaultUser = false;
    isAdministrator = false;
    config: Config;
    globalConfig: Config;

    static restore (userlist: UserList, value: any) {
        if (value.username && value.password) {
            return new User(userlist, value.username, value.password, Config.restore(value.config))
        }
    }

    authenticate(username: string, password: string) {
        return username === this.username && password === this.password
    }

    getPath() {
        if (this.config.path) return this.config.path
        if (this.globalConfig?.path) return pathlib.join(this.globalConfig.path, this.username)
        return pathlib.join(process.env.MPATH || pathlib.join(__dirname, "../data"), this.username)
    }

    getLimit() {
        if (this.config.limit && this.config.limit < 0) {
            return undefined
        } else if (this.config.limit) {
            return this.config.limit
        }
        if (this.globalConfig?.limit) return this.globalConfig.limit
    }

    asObject() {
        return {
            username: this.username,
            password: this.password,
            config: this.config.asObject()
        }
    }

    constructor(parent: UserList, username: string, password: string, config?: Config) {
        this.username = username;
        this.password = password;
        this.globalConfig = parent.config;
        if (config) {
            this.config = config
        } else {
            this.config = new Config()
        }
        this.isAdministrator = this.config.isAdministrator || false
        this.uid = username
        this.netfs = new NetFS(this)
        parent.privelegeManager.setRights(this, "/", ['all'])
    }
}

export class UserList {
    readonly path: string;
    readonly users: User[] = [];
    readonly privelegeManager: SimplePathPrivilegeManager;
    config: Config;

    async load() {
        const value = JSON.parse((await fsp.readFile(this.path)).toString())
        if (value.users) {
            this.config = Config.restore(value.config)
            value.users.forEach((value: any) => {
                if (!this.getUserByName(value.username)) {
                    this.addUserRaw(User.restore(this, value)!)
                }
            })
        }
    }

    authenticate(auth: string | undefined) {
        if (auth) {
            const b64auth = (auth || '').split(' ')[1] || ''
            const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':')
            debug(`attempting login as ${login}`)
            for (const user of this.users) {
                if (user.authenticate(login, password)) {
                    return user;
                }
            }
            debug(`login as ${login} failed`)
        }
    }

    removeUser(user: User) {
        const index = this.users.indexOf(user)
        if (index > -1) {
            this.privelegeManager.setRights(user, "/", [])
            this.users.splice(index, 1)
        }
    }

    addUser(username: string, password: string, config?: Config): void {
        const user = new User(this, username, password, config)
        this.users.push(user)
    }

    addUserRaw(user: User): void {
        this.users.push(user)
    }

    getUserByName(username: string) {
        for (let user of this.users) {
            if (username == user.username) {
                return user
            }
        }
    }

    getPath() {
        if (this.config.path) return this.config.path
        return pathlib.join(process.env.MPATH || pathlib.join(__dirname, "../data"))
    }

    asObject() {
        const uobjs: object[] = []
        this.users.forEach((user) => uobjs.push(user.asObject()))
        return {
            users: uobjs,
            config: this.config.asObject()
        }
    }
    
    async flush() {
        await fsp.writeFile(this.path, JSON.stringify(this.asObject(), null, 4))
    }

    constructor(path?: string, config?: Config) {
        if (config) {
            this.config = config
        } else {
            this.config = new Config()
        }
        this.path = path
        this.privelegeManager = new SimplePathPrivilegeManager()
        this.load()
    }
}