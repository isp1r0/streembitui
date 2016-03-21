/*
 
This file is part of W3C Web-of-Things-Framework.

W3C Web-of-Things-Framework is an open source project to create an Internet of Things framework.
This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by 
the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

W3C Web-of-Things-Framework is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of 
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with W3C Web-of-Things-Framework.  If not, see <http://www.gnu.org/licenses/>.
 
File created by Tibor Zsolt Pardi
 
Source is based on https://github.com/gordonwritescode  

Copyright (C) 2015 The W3C WoT Team
 
*/

'use strict';

var merge = require('merge');
var assert = require('assert');
var _ = require('lodash');
var async = require('async');
var inherits = require('util').inherits;
var utils = require('./utils');
var events = require('events');
var net = require('net');
var constants = require('./constants');
var Bucket = require('./bucket');
var Contact = require('./contact');
var Router = require('./router');
var Message = require('./message');
var Item = require('./item');
var transports = require('./transports');
var localstorage = require('./storages/localstorage');
var wotmsg = require('../../../libs/message/wotmsg');

inherits(Node, events.EventEmitter);

Node.DEFAULTS = {
    transport: transports.TCP //transports.UDP 
};

/**
* Represents a Kademlia node
* @constructor
* @param {object} options
*/
function Node(options) {
    
    if (!(this instanceof Node)) {
        return new Node(options);
    }
    
    events.EventEmitter.call(this);
    
    // 
    
    this._options = merge(Object.create(Node.DEFAULTS), options);
    this._storage = options.storage;
    
    assert(options.log && options.log.debug && options.log.error && options.log.info, 'No log adapter supplied');
    this._log = options.log;
    
    assert(typeof this._storage === 'object', 'No storage adapter supplied');
    assert(typeof this._storage.get === 'function', 'Store has no `get` method');
    assert(typeof this._storage.put === 'function', 'Store has no `put` method');
    assert(typeof this._storage.del === 'function', 'Store has no `del` method');
    assert(typeof this._storage.createReadStream === 'function', 'Store has no `createReadStream` method');
    
    if (this._options.is_private_network) {
        this._log.info('join PRIVATE network');
    }
    else {
        this._log.info('join PUBLIC network');
    }
    
    this.contact_existsfn = null;
    if (this._options.contact_exist_lookupfn) {
        this.contact_existsfn = this._options.contact_exist_lookupfn;
    }
    this._log.debug('contact_existsfn: ' + (this.contact_existsfn ? "defined" : "not defined"));
    
    this.is_gui_node = false;
    if (this._options.is_gui_node) {
        this.is_gui_node = true;
    }
    this._log.debug('is_gui_node: ' + (this.is_gui_node ? "defined" : "not defined"));
    
    this._buckets = {};
}

Node.prototype.init_maintain_thread = function () {
    
    this._log.debug('starting maintain thread');

    var self = this;
    
    var maintain_interval = this._options.maintainfreq ? this._options.maintainfreq : constants.T_MAINTAIN_INTERVAL;
    var maintainTimer = setInterval(
        function () {
            self.maintain();
        }, 
        maintain_interval
    );
}


Node.prototype.init = function (options, callback) {
    
    var self = this;
    
    this._log.debug('node init account %s', this._options.account);
    
    this._rpc = new this._options.transport(options);
    
    this._rpc.init(function (err) {
        if (err) {
            return callback(err);
        }
        
        self._self = self._rpc._contact;
        
        self._bindRPCMessageHandlers();        
        //  comment ou this and don't start the replication now
        //  self._startReplicationInterval();
        self._startExpirationInterval();
        
        self._log.debug('node create nodeID %s account %s', self._self.nodeID, self._options.account);

        if (options.seeds.length == 0) {
            return callback();
        }
        
        //var seedresults = [];
        
        async.mapSeries(
            options.seeds,
            function (seed, done) {
                self.connect(seed, function (err, node) {
                    var result = null;
                    
                    if (err) {
                        self._log.error("node connect error: %j", err);
                    }
                    else {
                        result = { seed: seed, error: err }
                        //seedresults.push(result);
                    }
                    
                    done(null, result);
                });
            },
            function (err, results) {
                if (err || results.length == 0) {
                    return callback("Failed to connect to any seed");
                }
                
                // start the maintain function
                self.init_maintain_thread();
                
                callback();
            });

    });
}

Node.prototype.create = function (onConnect) {
    
    assert(onConnect && typeof onConnect == "function", 'Invalid onConnect callback');
    
    if (this._options.seeds) {
        assert(Array.isArray(this._options.seeds), 'Invalid `options.seeds` supplied');
    } 
    else {
        this._options.seeds = [];
    }
    
    var options = this._options;
    
    if (options.seeds.length == 0) {
        return this.init(options, onConnect);
    }
    
    var self = this;
    
    // test if our listener connection can be opened
    
    this.discovery(options, function (err, result) {
        if (err) {
            return onConnect(err);
        }
        if (!result) {
            return onConnect("Node discovery error: invalid result");
        }
        
        var colonpos = result.lastIndexOf(':');
        if (colonpos > -1) {
            var ip = result.substring(colonpos + 1, result.length);
            result = ip;
        }
        
        self._log.debug('discovery address %s', result);
        
        //  initialize the node
        self._options.address = result;
        options.address = result;
        
        // initialize the node
        self.init(options, onConnect);
    });
}

Object.defineProperty(Node.prototype, 'Address', {
    get: function () {
        return this._self.address;
    }
})

Object.defineProperty(Node.prototype, 'Port', {
    get: function () {
        return this._self.port;
    }
})

Node.prototype.trylistening = function (options, resultfn) {
    var self = this;
    
    if (options && options.transport == transports.TCP) {   
    }
    
};

Node.prototype.discovery = function (options, resultfn) {
    
    var self = this;
    
    function handle_discovery(seed, fn) {
        var client = net.connect( 
            {
                port: seed.port, 
                host: seed.address
            },
            function () {
                client.write(JSON.stringify({ type: 'DISCOVERY' }));
            }
        );
        
        client.on('data', function (data) {
            client.end();
            var reply = JSON.parse(data.toString());
            if (reply && reply.address) {
                fn(null, reply.address);
            }
            else {
                fn("discovery failed for " + seed.address + ":" + seed.port);
            }
        });
        
        client.on('end', function () {
        });
        
        client.on('error', function (err) {
            fn("Discovery failed for " + seed.address + ":" + seed.port + ". " + (err.message ? err.message : err));
        });
    };
    
    var seeds = options.seeds;
    var validated_seeds = [];
    
    var seedFetchHandler = function (seed, callbackfn) {
        try {
            handle_discovery(seed, function (err, addr) {
                if (!err && addr) {
                    validated_seeds.push(seed);
                    callbackfn(null, addr);
                }
                else {
                    self._log.debug('peer discovery error %j', err);
                    //  don't return error because that will terminate the parallel  process
                    callbackfn(null);
                }
            });
        }
        catch (err) {
            self._log.error('peer discovery error %j', err);
            callbackfn(null);
        }
    };
    
    async.map(
        seeds, 
        seedFetchHandler, 
        function (err, results) {
            if (validated_seeds.length == 0 || !results || results.length == 0) {
                return resultfn("No seed is online. Please review the seed configuration in the configuration file!");
            }
            
            var address = null;
            for (var i = 0; i < results.length; i++) {
                if (results[i] != null) {
                    address = results[i];
                    break;
                }
            }
            
            if (!address) {
                return resultfn("Couldn't populate discovery address from seeds. Please review the seed configuration in the configuration file!");
            }
            
            for (var i = 0; i < validated_seeds.length; i++) {
                self._log.debug('valid seed %j', validated_seeds[i])
            }
            
            // remove the inactive seeds by modifying the seeds array
            options.seeds = validated_seeds;
            // return the first address
            resultfn(null, address);
        }
    );
};

//  This list to return a set of seed nodes to the client
//  so include the own account details of this node
Node.prototype.get_contacts = function () {
    var list_of_contacts = [];
    for (var bname in this._buckets) {
        var bucket = this._buckets[bname];
        var contacts = bucket.getContactList();
        for (var i = 0; i < contacts.length; i++) {
            list_of_contacts.push({ address: contacts[i].address, port: contacts[i].port, account: contacts[i].account });
        }
    }
    
    // add its own contact details
    list_of_contacts.push({ address: this._self.address, port: this._self.port, account: this._self.account });
    
    return list_of_contacts;
}


Node.prototype.get_seed_contact = function () {
    var seeds = this._options.seeds;
    for (var bname in this._buckets) {
        var bucket = this._buckets[bname];
        var contacts = bucket.getContactList();
        for (var i = 0; i < contacts.length; i++) {
            for (var j = 0; j < seeds.length; j++) {
                if (contacts[i].address == seeds[j].address && contacts[i].port == seeds[j].port) {
                    return { address: contacts[i].address, port: contacts[i].port };
                }
            }
        }
    }
}

Node.prototype.get_account_messages = function (account, msgkey, callback) {
    var self = this;
    
    var buffers = [];
    
    var seed = this.get_seed_contact();
    if (!seed) {
        return callback("no seed contact is available");
    }
    
    var client = net.connect( 
        {
            port: seed.port, 
            host: seed.address
        },
        function () {
            client.write(JSON.stringify({ type: 'MSGREQUEST', account: account, msgkey: msgkey }));
        }
    );
    
    client.on('data', function (data) {
        try {
            buffers.push(data);
        }
        catch (err) {
            callback("get_account_messages failed from " + seed.address + ":" + seed.port + "; error: " + err.message);
        }
    });
    
    client.on('end', function () {
        try {
            var reply = "";
            var databuffer = Buffer.concat(buffers);
            //console.log('databuffer length: ' + databuffer.length);
            try {
                var str = databuffer.toString();
                reply = JSON.parse(str);
            }
            catch (e) {
                reply = { error: "0x0111", message: "JSON parse error" };
            }
            callback(null, reply);
        }
        catch (err) {
            callback("get_account_messages failed from " + seed.address + ":" + seed.port + "; error: " + err.message);
        }
    });
    
    client.on('error', function (err) {
        callback("get_account_messages failed for " + seed.address + ":" + seed.port + "; error: " + (err.message ? err.message : err));
    });
};


Node.prototype.is_seedcontact_exists = function (callback) {
    
    try {
        var self = this;
        
        var isseed_contact = function () {
            var isseed = false;
            var seeds = self._options.seeds;
            for (var prop in self._buckets) {
                var bucket = self._buckets[prop];
                var bucket_contacts = bucket.getContactList();
                for (var i = 0; i < seeds.length; i++) {
                    for (var j = 0; j < bucket_contacts.length; j++) {
                        if (bucket_contacts[j].account == seeds[i].account) {
                            isseed = true;
                            break;
                        }
                    }
                }
            }
            
            return isseed;
        }
        
        var count = 0;
        var vtimeout = setInterval(
            function () {
                var seedcontact = isseed_contact();
                if (seedcontact) {
                    clearTimeout(vtimeout);
                    callback(true);
                }
                count++;
                if (count > 10) {
                    clearTimeout(vtimeout);
                    callback(false);
                }
            },
            3000
        );
    }
    catch (err) {
        callback(false);
        self._log.error("Node is_seed_contact error: %j", err);
    }
};

Node.prototype.validate_connection = function (resultfn) {
    var self = this;
    try {
        
        var pingProc = function (contact, callback) {
            self._log.debug('PING to validate_connection contact: %j', contact);
            var pingMessage = new Message('PING', { recipient: contact.account }, self._self);
            self._rpc.send(contact, pingMessage, function (err) {
                if (err) {
                    self._log.error('validate_connection PING contact: %j error: %j', contact, err);
                    callback(null);
                }
                else {
                    self._log.debug('validate_connection complete contact: %j', contact);
                    callback(null, contact.account);
                }
            });
        };
        
        var seeds = this._options.seeds;
        var contacts = [];
        for (var prop in this._buckets) {
            var bucket = this._buckets[prop];
            var bucket_contacts = bucket.getContactList();
            for (var i = 0; i < seeds.length; i++) {
                for (var j = 0; j < bucket_contacts.length; j++) {
                    if (bucket_contacts[j].account == seeds[i].account) {
                        contacts.push(bucket_contacts[j]);
                    }
                }
            }
        }
        
        async.map(
            contacts, 
            pingProc, 
            function (err, results) {
                if (!results || results.length == 0) {
                    return resultfn("Communication with peers failed. Check your firewall, DMZ and port forwarding settings to allow peer-to-peer communication on port " + self.Port);
                }
                
                var seed = null;
                for (var i = 0; i < results.length; i++) {
                    if (results[i] != null) {
                        seed = results[i];
                        break;
                    }
                }
                
                if (!seed) {
                    return resultfn("Communication with peers failed. Check your firewall, DMZ and port forwarding settings to allow peer-to-peer communication on port " + self.Port);
                }
                
                // return the first address
                resultfn(null);
            }
        );
    }
    catch (err) {
        resultfn(err);
        self._log.error("Node validate connection error: %j", err);
    }
};


Node.prototype.maintain = function () {
    self._log.debug('maintain contacts thread ...');
    var self = this;
    try {
        var pingProc = function (bucket, contacts) {
            async.each(
                contacts, 
                function (contact, callback) {
                    var pingMessage = new Message('PING', { recipient: contact.account }, self._self);
                    self._rpc.send(contact, pingMessage, function (err) {
                        if (err) {
                            self._log.debug('PING failed. maintain thread removes inactive contact %s from bucket', contact.account);
                            bucket.removeContact(contact);
                        }
                        
                        callback();
                    });
                }, 
                function (err) {
                    if (err) {
                        self._log.error('maintain PING error: %j', err);
                    }
                }
            );
        }
        
        for (var prop in this._buckets) {
            var bucket = this._buckets[prop];
            var contacts = bucket.getContactList();
            //this._log.debug('bucket[' + prop + '] contacts: %j', contacts);
            // ping to the contact to check if it is online
            pingProc(bucket, contacts);
        }
    }
    catch (err) {
        self._log.error("Node maintain error: %j", err);
    }
};



Node.prototype.close = function () {
    this._rpc.close();
};


Node.prototype.errorHandler = function (errcode, errmsg) {
    if (this.errorFn) {
        this.errorFn(errcode, errmsg);
    }
};

/**
* Connects to the overlay network
* #connect
* @param {string} options transport-specific contact options
* @param {function} callback - optional
*/
Node.prototype.connect = function (options, callback) {
    
    if (callback) {
        this.once('connect', callback);
        this.once('error', callback);
    }
    
    this._log.debug('_createContact for %j', options);
    
    var self = this;
    var seed = this._rpc._createContact(options);
    
    this._log.debug('entering overlay network via %j', seed);
    
    async.waterfall(
        [
            this._updateContact.bind(this, seed),
            this._findNode.bind(this, this._self.nodeID),
            this._refreshBucketsBeyondClosest.bind(this)
        ], 
        function (err) {
            if (err) {
                return self.emit('error', err);
            }
            
            self.emit('connect', null, (self && self._self ? self._self : null));
        });
    
    return this;
};

Node.prototype.ping = function (seed, callback) {
    this._log.debug('Node PING to %j', seed);
    
    var contact = this._rpc._createContact(seed);
    
    assert(contact instanceof Contact, 'Invalid contact created');
    
    var self = this;
    
    var pingMessage = new Message('PING', {}, this._self);
    
    this._rpc.send(contact, pingMessage, function (err) {
        if (err) {
            self._log.debug('ping contact did not respond, replacing with new');
        }
        
        complete();
    });
    
    function complete() {
        if (typeof callback === 'function') {
            callback();
        }
    }
};


Node.prototype.getNode = function (account, callback) {
    var self = this;
    
    var nodeid = utils.createID(account);
    this._log.debug('getNode account: %s, nodeid: %s', account, nodeid);
    
    this._find(nodeid, 'NODE', function (err, type, contacts) {
        if (err) {
            return callback(err);
        }
        
        self._log.debug('getNode found %d nodes close to key %s', contacts.length, nodeid);
        
        callback(null, contacts);
    });
};



/**
* Set a key/value pair in the DHT
* #set
* @param {string} key
* @param {mixed} value
* @param {function} callback
*/
Node.prototype.put = function (key, value, callback) {
    var node = this;
    
    this._log.debug('put key %s', key);
    
    var item = new Item(key, value, this._self.nodeID);
    
    var message = new Message('STORE', item, this._self);
    
    this._findNode(item.key, function (err, contacts) {
        if (err) {
            node._log.error('failed to find nodes - reason: %s', err.message);
            return callback(err);
        }
        
        if (contacts.length === 0) {
            node._log.error('no contacts are available');
            contacts = node._getNearestContacts(key, constants.K, node._self.nodeID);
        }
        
        //node._log.debug('found %d contacts for STORE operation', contacts.length);
        
        async.map(
            contacts, 
            function (contact, done) {
                //node._log.debug('sending STORE message to %j', contact, {});            
                node._rpc.send(contact, message, function (err) {
                    var fnresult = {
                        status: 0,
                        error: null,
                        contact: contact
                    };
                    if (err) {
                        fnresult.status = 1;
                        fnresult.error = err;
                    }
                    
                    done(null, fnresult);
                });
            }, 
            function (err, resultsarr) {
                callback(err, resultsarr);
                //node._log.debug('resultsarr: %j', resultsarr);
            }
        );

    });
};


Node.prototype._findValue = function (key, callback) {
    var self = this;
    try {
        //this._log.debug('searching for value at key %s', key);
        
        this._find(key, 'VALUE', function (err, type, value) {
            if (err || type === 'NODE') {
                return callback(new Error('error: 0x0100 data: ' + key + ' msg: Failed to find value for key'));
            }
            
            //self._log.debug('found value for key %s', key);
            
            callback(null, value);
        });
    }
    catch (e) {
        self.errorHandler(0x010f);
        node._log.error("_findValue error: %j", e);
    }
};


Node.prototype.get = function (key, callback) {
    var node = this;
    
    //this._log.debug('attempting to get value for key %s', key);
    
    this._storage.get(key, function (err, data) {
        if (!err && data) {
            try {
                var obj = JSON.parse(data);
                if (obj && obj.value) {
                    return callback(null, obj.value);
                }
            }
            catch (e) {
                node._log.error('_storage.get JSON parse error');
            }
            return callback(null, data.value);
        }
        
        node._log.debug('key ' + key + ' is not in the local storage try to get it from the network');
        
        node._findValue(key, function (err, value) {
            if (err) {
                return callback(err);
            }
            
            callback(null, value);
        });

    });
};


Node.prototype.find = function (key, callback) {
    var self = this;
    
    if (this._options.is_private_network) {
        var account_key = key.indexOf("/") == -1;
        if (account_key) {
            var account_allowed = false;
            if (this._options.private_network_accounts) {
                var accounts = this._options.private_network_accounts;
                for (var i = 0; i < accounts.length; i++) {
                    if (key == accounts[i].account) {
                        account_allowed = true;
                        break;
                    }
                }
            }
            
            if (!account_allowed) {
                var errmsg = "account: " + key + " permission denied";
                return callback(err);
                return this._log.error("find() " + errmsg);
            }
        }
    }
    
    this._log.debug('attempting to find value for key %s', key);
    
    self._findValue(key, function (err, value) {
        if (err) {
            return callback(err);
        }
        
        callback(null, value);
    });
};


Node.prototype._bindRPCMessageHandlers = function () {
    var self = this;
    
    this._rpc.on('PING', this._handlePing.bind(this));
    this._rpc.on('STORE', this._handleStore.bind(this));
    this._rpc.on('FIND_NODE', this._handleFindNode.bind(this));
    this._rpc.on('FIND_VALUE', this._handleFindValue.bind(this));
    this._rpc.on('CONTACT_SEEN', this._updateContact.bind(this));
    
    if (this._options.errhandler && (typeof this._options.errhandler == "function")) {
        this._rpc.on('NODE_ERROR', this._options.errhandler.bind(this));
    }
    
    if (this._options.peermsgHandler && (typeof this._options.peermsgHandler == "function")) {
        this._rpc.on('PEERMSG', this._options.peermsgHandler.bind(this));
    }
    
    if (this._options.pinghandler && (typeof this._options.pinghandler == "function")) {
        this._rpc.on('PONG', this._options.pinghandler.bind(this));
    }
    
    this._rpc.on('ready', function () {
        self._log.debug('node listening on %s:%d', self._self.address, self._self.port);
    });
    
    this._rpc.on('MSGREQUEST', this.get_stored_messages.bind(this));
    
};


Node.prototype._startReplicationInterval = function () {
    if (this._options.is_private_network) {
        this._log.debug('NO replication is set in private network');
        return;
    }
    
    setInterval(this._replicate.bind(this), constants.T_REPLICATE);
};


Node.prototype._replicate = function () {
    
    if (this._options.is_private_network) {
        this._log.debug('NO replication is performed in private network');
        return;
    }
    
    var self = this;
    var stream = this._storage.createReadStream();
    
    this._log.info('starting local database replication');
    
    stream.on('data', function (data) {
        if (typeof data.value === 'string') {
            try {
                data.value = JSON.parse(data.value);
            } 
            catch (err) {
                return self._log.error('failed to parse value from %s', data.value);
            }
        }
        
        // if we are not the publisher, then replicate the item
        if (data.value.publisher !== self._self.nodeID) {
            self.put(data.key, data.value.value, function (err) {
                if (err) {
                    self._log.error('failed to replicate item at key %s', data.key);
                }
            });
        } 
        else if (Date.now() <= data.value.timestamp + constants.T_REPUBLISH) {
            // if we are the publisher, then only replicate at every T_REPUBLISH interval
            self.put(data.key, data.value.value, function (err) {
                if (err) {
                    self._log.error('failed to republish item at key %s', data.key);
                }
            });
        }
    });
    
    stream.on('error', function (err) {
        self._log.error('error while replicating: %s', err.message);
    });
    
    stream.on('end', function () {
        self._log.info('database replication complete');
    });
};


Node.prototype.get_stored_messages = function (account, msgkey, callback) {
    var self = this;
    var stream = this._storage.createReadStream();
    
    this._log.debug('get_stored_messages for %s', account);
    
    var count = 0;
    var messages = [];
    
    stream.on('data', function (data) {
        if (typeof data.value === 'string') {
            try {
                data.value = JSON.parse(data.value);
            } 
            catch (err) {
                return self._log.error('get_stored_messages failed to parse value');
            }
        }
        
        if (data.value.recipient && data.value.recipient == account) {
            var keyitems = data.key.split("/");
            if (keyitems && keyitems.length > 2 && keyitems[1] == "message") {
                if (messages.length < 10) {
                    messages.push({ key: data.key, value: data.value.value });
                }
                count++;
            }
        }
    });
    
    stream.on('error', function (err) {
        callback(err.message ? err.message : err);
    });
    
    stream.on('end', function () {
        callback(null, count, messages);
    });
};


Node.prototype.delete_account_message = function (request, callback) {
    try {
        var node = this;
        
        var payload = wotmsg.getpayload(request.value);
        if (!payload || !payload.data || !payload.data.type || payload.data.type != wotmsg.MSGTYPE.DELMSG) {
            return callback("delete_account_message error invalid payload");
        }
        
        var account = payload.iss;
        
        if (!account) {
            return callback("delete_account_message error i.nvalid iss field");
        }
        
        var msgid = payload.data[wotmsg.MSGFIELD.MSGID];
        if (!msgid) {
            return this._log.error("delete_account_message error: invalid mssgid for delete message");
        }
        
        this.get(account, function (err, value) {
            try {
                if (err) {
                    return callback('delete_account_message get existing PK error %j', err);
                }
                
                var stored_payload = wotmsg.getpayload(value);
                var stored_pkkey = stored_payload.data[wotmsg.MSGFIELD.PUBKEY];
                if (!stored_pkkey) {
                    return callback('delete_account_message error: stored public key does not exists');
                }
                
                var decoded_msg = wotmsg.decode(request.value, stored_pkkey);
                if (!decoded_msg) {
                    return callback('VERIFYFAIL %s', account);
                }
                
                var delkey = account + "/message/" + msgid;
                node.delete_item(delkey);
                
                node._log.debug("account message: " + delkey + " is deleted");
            }
            catch (val_err) {
                callback(val_err);
            }
        });
    }
    catch (e) {
        callback(e);
    }

};

Node.prototype.delete_item = function (key) {
    var self = this;
    this._storage.del(key, function (err) {
        if (err) {
            self._log.error('failed to delete item with key %s', key);
        }
    });
};


Node.prototype._startExpirationInterval = function () {
    setInterval(this._expire.bind(this), constants.T_EXPIRE);
};


Node.prototype._expire = function () {
    var self = this;
    var stream = this._storage.createReadStream();
    
    this._log.debug('starting local database cleanup');
    
    stream.on('data', function (data) {
        try {
            if ((!data || !data.key) || data.key.indexOf("/") == -1) {
                //  The account-key messages publishes the public key of the account to the network
                //  Delete the message if it is marked to be deleted, otherwise never delete the account-key messages           
                
                var obj = JSON.parse(data.value);
                if (obj && obj.value) {
                    var payload = wotmsg.getpayload(obj.value);
                    if ((!payload || !payload.data || !payload.data.type) ||
                        payload.data.type == wotmsg.MSGTYPE.DELPK) {
                        self._log.debug('DELETE public key of ' + data.key);
                        self._storage.del(data.key, function (err) {
                            if (err) {
                                self._log.error('failed to expire item at key %s', data.key);
                            }
                            else {
                                self._log.debug('public key for %s is deleted from the node', data.key);
                            }
                        });
                    }
                }
                
                return;
            }
            
            var value = JSON.parse(data.value);
            if (!value || !value.timestamp) {
                self._log.debug("_expire delete %s", data.key);
                self._storage.del(data.key, function (err) {
                    if (err) {
                        self._log.error('failed to expire item at key %s', data.key);
                    }
                });
                return;
            }
            
            var currtime = Date.now();
            var expiry_time = 0;
            var keyitems = data.key.split("/");
            if (keyitems && keyitems.length > 2 && keyitems[1] == "message") {
                expiry_time = value.timestamp + constants.T_MSG_EXPIRE;
            }
            else {
                expiry_time = value.timestamp + constants.T_ITEM_EXPIRE;
            }
            
            if (expiry_time <= currtime) {
                self._log.debug("_expire delete %s", data.key);
                self._storage.del(data.key, function (err) {
                    if (err) {
                        self._log.error('failed to expire item at key %s', data.key);
                    }
                });
            }
        }
        catch (e) {
            try {
                if (data && data.key) {
                    self._storage.del(data.key, function (err) {
                        if (err) {
                            self._log.error('Exception handler error. Failed to delete for key %s', data.key);
                        }
                    });
                }
            }
            catch (delerr) {
                self._log.error('Fatal error in exception handling: %j', delerr);
            }
        }
    });
    
    stream.on('error', function (err) {
        self._log.error('error while cleaning up database: %s', err.message);
    });
    
    stream.on('end', function () {
        self._log.debug('local database cleanup complete');
    });
};

/**
* Refreshes the buckets farther than the closest known
* #_refreshBucketsBeyondClosest
* @param {string} type
* @param {array} contacts
* @param {function} done
*/
Node.prototype._refreshBucketsBeyondClosest = function (contacts, done) {
    
    var bucketIndexes = Object.keys(this._buckets);
    var leastBucket = _.min(bucketIndexes);
    var refreshBuckets = bucketIndexes.filter(bucketFilter);
    var queue = async.queue(this._refreshBucket.bind(this), 1);
    
    //this._log.debug('refreshing buckets farthest than closest known');
    
    refreshBuckets.forEach(function (index) {
        queue.push(index);
    });
    
    function bucketFilter(index) {
        return index >= leastBucket;
    }
    
    done();
};

/**
* Refreshes the bucket at the given index
* #_refreshBucket
* @param {number} index
* @param {function} callback
*/
Node.prototype._refreshBucket = function (index, callback) {
    var random = utils.getRandomInBucketRangeBuffer(index);
    
    this._findNode(random.toString('hex'), callback);
};


/**
* Search contacts for nodes close to the given key
* #_findNode
* @param {string} nodeID
* @param {function} callback
*/
Node.prototype._findNode = function (nodeID, callback) {
    var self = this;
    
    this._log.debug('searching for nodes close to key %s', nodeID);
    
    this._find(nodeID, 'NODE', function (err, type, contacts) {
        if (err) {
            return callback(err);
        }
        
        //self._log.debug('_findNode found %d nodes close to key %s', contacts.length, nodeID);
        
        callback(null, contacts);
    });
};

/**
* Search contacts for nodes/values
* #_find
* @param {string} key
* @param {string} type - ['NODE', 'VALUE']
* @param {function} callback
*/
Node.prototype._find = function (key, type, callback) {
    Router(type, key, this).route(callback);
};



Node.prototype._updateContact = function (contact, callback) {
    assert(contact instanceof Contact, 'Invalid contact supplied');
    
    //this._log.debug('updating contact %j', contact);
    
    var self = this;
    var bucketIndex = utils.getBucketIndex(this._self.nodeID, contact.nodeID);
    
    assert(bucketIndex < constants.B);
    
    if (!this._buckets[bucketIndex]) {
        //this._log.debug('creating new bucket for contact at index %d', bucketIndex);
        this._buckets[bucketIndex] = new Bucket();
    }
    
    var bucket = this._buckets[bucketIndex];
    var inBucket = bucket.hasContact(contact.nodeID);
    var bucketHasRoom = bucket.getSize() < constants.K;
    var contactAtHead = bucket.getContact(0);
    
    contact.seen();
    
    if (inBucket) {
        //this._log.debug('contact already in bucket, moving to tail');
        bucket.removeContact(contact);
        bucket.addContact(contact);
        complete();
    } 
    else if (bucketHasRoom) {
        //this._log.debug('contact not in bucket, moving to head');
        bucket.addContact(contact);
        complete();
    } 
    else {
        //this._log.debug('no room in bucket, sending PING to contact at head');
        var pingMessage = new Message('PING', {}, this._self);
        this._rpc.send(contactAtHead, pingMessage, function (err) {
            if (err) {
                self._log.debug('head contact did not respond, replacing with new');
                bucket.removeContact(contactAtHead);
                bucket.addContact(contact);
            }
            
            complete();
        });
    }
    
    function complete() {
        if (typeof callback === 'function') {
            callback();
        }
    }
    
    return contact;
};


/**
* Handle `PING` RPC
* #_handlePing
* @param {object} params
*/
Node.prototype._handlePing = function (params, sockinfo) {
    //this._log.debug('_handlePing params: %j, sockinfo: %j', params, sockinfo);
    
    var recipient = params.recipient;
    if (recipient != this._self.account) {
        this._log.error('The PING recipient ' + recipient + ' is invalid for contact ' + this._self.account + ' - do not send reply');
        return;
    }
    
    var reply = { referenceID: params.rpcID, account: this._self.account };
    
    //this._log.debug('PING reply %j', reply);
    
    var message = new Message('PONG', reply, this._self);
    
    if (params.address != sockinfo.address) {
        params.address = sockinfo.address;
    }
    
    var contact = this._rpc._createContact(params);
    this._rpc.send(contact, message);
};




Node.prototype._handleStore = function (params) {
    var node = this;
    var item;
    var is_update_key = false, is_system_update_key = false;
    var msgid;
    
    //this._log.info('received valid STORE from %s', params.nodeID);
    
    var payload = wotmsg.getpayload(params.value);
    if (!payload || !payload.data || !payload.data.type) {
        return this._log.error("handleStore error invalid payload");
    }
    
    if (payload.data.type == wotmsg.MSGTYPE.PUBPK || payload.data.type == wotmsg.MSGTYPE.UPDPK || payload.data.type == wotmsg.MSGTYPE.DELPK) {
        if (!payload.data[wotmsg.MSGFIELD.PUBKEY]) {
            return this._log.error("handleStore error invalid public key payload");
        }
        is_update_key = true;
    }
    
    if (is_update_key) {
        if (this._options.is_private_network) {
            var account_allowed = false;
            var accounts = this._options.private_network_accounts;
            for (var i = 0; i < accounts.length; i++) {
                if (params.account == accounts[i].account) {
                    account_allowed = true;
                    break;
                }
            }
            
            if (!account_allowed) {
                return this._log.error("handleStore() account: " + params.account + " permission denied");
            }
        }
    }
    
    // check if this is a gui node. gui nodes updates only contact messages
    if (this.is_gui_node) {
        if (!is_update_key && !is_system_update_key) {
            // only store the contacts key and system update messages in the gui version
            return node._log.debug("handleStore is_gui_node = true, no STORE perfomed");
        }
        
        if (is_update_key) {
            if (!this.contact_existsfn) {
                return node._log.debug("handleStore cancelled, contact_existsfn not exists");
            }
            
            // check if the contact exists
            try {
                var account = params.key;
                var iscontact = this.contact_existsfn(account);
                if (!iscontact) {
                    return node._log.debug("handleStore cancelled, contact_existsfn for " + account + " returned false");
                }
                else {
                    node._log.debug("handleStore contact_existsfn for " + account + " returned TRUE");
                }
            } 
            catch (err) {
                return this._log.error("handleStore contact_existsfn call error %j", err);
            }
        }
        
        if (is_system_update_key) {
            // TODO
        }
    }
    
    try {
        // create the message item object
        var recipient = null;
        if (payload.data.type == wotmsg.MSGTYPE.OMSG) {
            recipient = payload.aud;
        }
        item = new Item(params.key, params.value, params.nodeID, null, recipient);
    } 
    catch (err) {
        return this._log.error("handleStore item create error %j  key: %s", err, (item && item.key) || "unknown");
    }
    
    var account_key;
    if (is_update_key) {
        //  is_update_key == true -> the publisher claims this is a public key store, update or delete message
        //  check if the existing key does exits and if yes then validate the message
        account_key = item.key;
    }
    else {
        //  get the iss field of the JSON web token message
        account_key = payload.iss;
    }
    
    if (!account_key) {
        return this._log.error("handleStore error: invalid public key account field");
    }
    
    if (payload.data.type == wotmsg.MSGTYPE.DELMSG) {
        msgid = payload.data[wotmsg.MSGFIELD.MSGID];
        if (!msgid) {
            return this._log.error("handleStore error: invalid mssgid for delete message");
        }
    }
    
    this.get(account_key, function (err, value) {
        try {
            if (err) {
                if (is_update_key && err.message && err.message.indexOf("error: 0x0100") > -1) {
                    node._log.debug('handleStore PUBPK key not exists on the network, allow to complete PUBPK message');
                    
                    if (node._options.is_private_network) {
                        var newpkey = payload.data[wotmsg.MSGFIELD.PUBKEY];
                        var is_key_matches = false;
                        var accounts = node._options.private_network_accounts;
                        for (var i = 0; i < accounts.length; i++) {
                            if (params.account == accounts[i].account && newpkey == accounts[i].publickey) {
                                is_key_matches = true;
                                break;
                            }
                        }
                        
                        if (!is_key_matches) {
                            return node._log.error("handleStore() public key mismatch for acount: " + params.account + " permission denied");
                        }
                    }
                    
                    return node._storeValue(item, params);
                }
                else {
                    node.errorHandler(0x0102);
                    return node._log.debug('handleStore get existing PK error %j', err);
                }
            }
            else {
                node._log.debug("handleStore decode wot message");
                var stored_payload = wotmsg.getpayload(value);
                var stored_pkkey = stored_payload.data[wotmsg.MSGFIELD.PUBKEY];
                if (!stored_pkkey) {
                    node.errorHandler(0x0104);
                    node._log.error('handleStore error: stored public key does not exists');
                    return;
                }
                
                // if this is a private network then the public key must matches with the account's key in the list of public key
                if (node._options.is_private_network) {
                    var is_key_matches = false;
                    var accounts = node._options.private_network_accounts;
                    for (var i = 0; i < accounts.length; i++) {
                        if (stored_pkkey == accounts[i].publickey) {
                            is_key_matches = true;
                            break;
                        }
                    }
                    
                    if (!is_key_matches) {
                        return node._log.error("handleStore() public key mismatch for acount: " + params.account + " permission denied");
                    }
                }
                
                node._log.debug("_handleStore validate account: " + account_key + " public key: " + stored_pkkey);
                
                if (payload.data.type == wotmsg.MSGTYPE.PUBPK || 
                    payload.data.type == wotmsg.MSGTYPE.UPDPK || 
                    payload.data.type == wotmsg.MSGTYPE.DELPK ||
                    payload.data.type == wotmsg.MSGTYPE.OMSG ||
                    payload.data.type == wotmsg.MSGTYPE.DELMSG) {
                    var decoded_msg = wotmsg.decode(params.value, stored_pkkey);
                    if (!decoded_msg) {
                        node.errorHandler(0x0109);
                        return node._log.error('VERIFYFAIL %s', account);
                    }
                    
                    //  passed the validation -> add to the network
                    node._log.debug('handleStore validation for msgtype: ' + payload.data.type + '  is OK');
                    
                    //node._log.debug('data: %j', params);
                    node._storeValue(item, params, function () {
                        try {
                            if (payload.data.type == wotmsg.MSGTYPE.DELMSG) {
                                var delkey = account_key + "/message/" + msgid;
                                node.delete_item(delkey);
                                node._log.debug('handleStore message: ' + delkey + '  is deleted');
                            }
                        }
                        catch (delerr) {
                            node._log.error("handleStore, delete_item error: %j", delerr);
                        }
                    });
                }
            }
        }
        catch (val_err) {
            node.errorHandler(0x01071);
            node._log.error("handleStore error: %j", val_err);
        }
    });
    
};


Node.prototype._storeValue = function (item, params, callback) {
    var node = this;
    try {
        this._storage.put(item.key, JSON.stringify(item), function (err) {
            var contact = node._rpc._createContact(params);
            var message = new Message(
                'STORE_REPLY', {
                    referenceID: params.rpcID,
                    success: !!err
                }, 
                node._self);
            
            //node._log.debug('successful store, notifying %s', params.nodeID);
            node._rpc.send(contact, message);
            
            // signal an event that the message was stored
            node.emit('msgstored', node._self.nodeID, item);
            
            if (callback) {
                callback();
            }
        });
    }
    catch (e) {
        node.errorHandler(0x010b);
        node._log.error("_storeValue error: %j", e);
    }
};


/**
* Handle `FIND_NODE` RPC
* #_handleFindNode
* @param {object} params
*/
Node.prototype._handleFindNode = function (params) {
    try {
        //this._log.debug('received FIND_NODE from %j', params);
        
        var contact = this._rpc._createContact(params);
        var near = this._getNearestContacts(params.key, constants.K, params.nodeID);
        
        var message = new Message(
            'FIND_NODE_REPLY', 
            {
                referenceID: params.rpcID,
                contacts: near
            }, 
            this._self);
        
        //this._log.debug('sending %s nearest %d contacts', params.nodeID, near.length, {});
        
        this._rpc.send(contact, message);
    }
    catch (e) {
        this.errorHandler(0x010c);
        this._log.error("_handleFindNode error: %j", e);
    }
};

/**
* Handle `FIND_VALUE` RPC
* #_handleFindValue
* @param {object} params
*/
Node.prototype._handleFindValue = function (params) {
    var node = this;
    try {
        var contact = this._rpc._createContact(params);
        var limit = constants.K;
        
        //this._log.debug('received valid FIND_VALUE from %s key: %s', params.nodeID, params.key);
        
        if (this._options.is_private_network) {
            if (!this._options.private_network_accounts || this._options.private_network_accounts.length == 0) {
                return this._log.error("_handleFindValue() error: invalid private_network_accounts list");
            }
            
            var is_permission_granted = false;
            
            var accounts = this._options.private_network_accounts;
            for (var i = 0; i < accounts.length; i++) {
                if (params.account == accounts[i].account) {
                    is_permission_granted = true;
                    break;
                }
            }
            
            if (!is_permission_granted) {
                return this._log.error("_handleFindValue() account: " + params.account + " is not allowed to find value");
            }
            
            is_permission_granted = false;
            
            var account_key = params.key.indexOf("/") == -1;
            if (account_key) {
                for (var i = 0; i < accounts.length; i++) {
                    if (params.key == accounts[i].account) {
                        is_permission_granted = true;
                        break;
                    }
                }
                
                if (!is_permission_granted) {
                    return this._log.error("_handleFindValue() find key: " + params.key + " permission denied");
                }
            }
        }
        
        this._storage.get(params.key, function (err, value) {
            if (err || !value) {
                //node._log.debug('value not found, sending contacts to %s', params.nodeID);
                
                var notFoundMessage = new Message('FIND_VALUE_REPLY', {
                    referenceID: params.rpcID,
                    contacts: node._getNearestContacts(params.key, limit, params.nodeID)
                }, node._self);
                
                return node._rpc.send(contact, notFoundMessage);
            }
            
            //node._log.debug('found value, sending to %s', params.nodeID);
            
            var foundMessage = new Message('FIND_VALUE_REPLY', {
                referenceID: params.rpcID,
                value: value
            }, contact);
            
            node._rpc.send(contact, foundMessage);
        });
    }
    catch (e) {
        node.errorHandler(0x010d);
        node._log.error("_handleFindValue error: %j", e);
    }
};

/**
* Return contacts closest to the given key
* #_getNearestContacts
* @param {string} key
* @param {number} limit
* @param {string} nodeID
*/
Node.prototype._getNearestContacts = function (key, limit, nodeID) {
    
    var contacts = [];
    var hashedKey = utils.createID(key);
    var initialIndex = utils.getBucketIndex(this._self.nodeID, hashedKey);
    var ascBucketIndex = initialIndex;
    var descBucketIndex = initialIndex;
    
    if (this._buckets[initialIndex]) {
        addNearestFromBucket(this._buckets[initialIndex]);
    }
    
    while (contacts.length < limit && ascBucketIndex < constants.B) {
        ascBucketIndex++;
        
        if (this._buckets[ascBucketIndex]) {
            addNearestFromBucket(this._buckets[ascBucketIndex]);
        }
    }
    
    while (contacts.length < limit && descBucketIndex >= 0) {
        descBucketIndex--;
        
        if (this._buckets[descBucketIndex]) {
            addNearestFromBucket(this._buckets[descBucketIndex]);
        }
    }
    
    function addToContacts(contact) {
        var isContact = contact instanceof Contact;
        var poolNotFull = contacts.length < limit;
        var notRequester = contact.nodeID !== nodeID;
        
        if (isContact && poolNotFull && notRequester) {
            contacts.push(contact);
        }
    }
    
    function addNearestFromBucket(bucket) {
        var contactList = bucket.getContactList();
        var distances = contactList.map(addDistance).sort(sortKeysByDistance);
        var howMany = limit - contacts.length;
        
        distances.splice(0, howMany).map(pluckContact).forEach(addToContacts);
    }
    
    function pluckContact(c) {
        return c.contact;
    }
    
    function sortKeysByDistance(a, b) {
        return utils.compareKeys(a.distance, b.distance);
    }
    
    function addDistance(contact) {
        return {
            contact: contact,
            distance: utils.getDistance(contact.nodeID, hashedKey)
        };
    }
    
    return contacts;
   
};

Node.prototype.peer_send = function (contact, message) {
    assert(contact && contact.address && contact.port, 'Node peer_send error: Invalid contact supplied');
    // the caller must NOT serialize with JSON.stringify the data, the RPC object will create a string
    assert(message && (typeof message == "object" || typeof message == "Object" || typeof message == "Buffer" || typeof message == "buffer"), 
        'Node peer_send error: Invalid message supplied');
    
    this._rpc.peer_send(contact, message);
}

module.exports = Node;
