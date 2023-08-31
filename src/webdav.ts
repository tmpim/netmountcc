import { FileSystem, IStorageManager, IStorageManagerEvaluateCallback, Path, PropertyAttributes, RequestContext, ResourcePropertyValue, ResourceType } from "webdav-server/lib/index.v2";
import { XMLElement } from 'xml-js-builder'
import { UserList } from "./userlist";

export class UserListStorageManager implements IStorageManager
{
    readonly userlist: UserList
    storage : {
        [UUID : string] : number
    }

    constructor(userlist: UserList)
    {
        this.storage = {};
        this.userlist = userlist
    }

    reserve(ctx : RequestContext, fs : FileSystem, size : number, callback : (reserved : boolean) => void) : void
    {
        let nb = this.storage[ctx.user.uid];
        if(nb === undefined)
            nb = 0;
        nb += size;

        const davuser = this.userlist.getUserByDavuser(ctx.user)
        if(nb > (davuser!.getLimit() || 0))
            return callback(false);

        this.storage[ctx.user.uid] = Math.max(0, nb);
        callback(true);
    }

    evaluateCreate(ctx : RequestContext, fs : FileSystem, path : Path, type : ResourceType, callback : IStorageManagerEvaluateCallback) : void
    {
        fs.getFullPath(ctx, path, (e, fullPath) => {
            callback(fullPath!.toString().length);
        })
    }
    evaluateContent(ctx : RequestContext, fs : FileSystem, expectedSize : number, callback : IStorageManagerEvaluateCallback) : void
    {
        callback(expectedSize);
    }

    evalPropValue(value : ResourcePropertyValue) : number
    {
        if (!value)
            return 0;
        if(value.constructor === String)
            return (value as String).length;
        if(Array.isArray(value))
            return (value as XMLElement[]).map((el) => this.evalPropValue(el)).reduce((p, n) => p + n, 0);

        const xml = value as XMLElement;
        const attributesLength = Object.keys(xml.attributes).map((at) => at.length + (xml.attributes[at].length as number)).reduce((p, n) => p + n, 0);
        return xml.name.length + attributesLength + (xml.elements && xml.elements.length > 0 ? this.evalPropValue(xml.elements) : 0);
    }
    evaluateProperty(ctx : RequestContext, fs : FileSystem, name : string, value : ResourcePropertyValue, attributes : PropertyAttributes, callback : IStorageManagerEvaluateCallback) : void
    {
        callback(name.length + Object.keys(attributes).map((ak) => attributes[ak].length + ak.length).reduce((p, n) => p + n, 0) + this.evalPropValue(value));
    }

    available(ctx : RequestContext, fs : FileSystem, callback : (available : number) => void) : void
    {
        const nb = this.storage[ctx.user.uid];
        const limit = this.userlist.getUserByDavuser(ctx.user)!.getLimit()
        if (!limit) {
            callback(-1)
        } else {
            callback(nb === undefined ? limit : limit - nb);
        }
    }
    reserved(ctx : RequestContext, fs : FileSystem, callback : (reserved : number) => void) : void
    {
        const nb = this.storage[ctx.user.uid];
        callback(nb === undefined ? 0 : nb);
    }
}