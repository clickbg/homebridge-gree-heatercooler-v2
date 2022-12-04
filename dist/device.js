const EventEmitter = require("events");
const dgram = require("dgram");
const crypto = require("./crypto");
const commands = require("./commands");

const retryInterval = 5000;
const updateInterval = 1000;

class Device {
  constructor(log, config, updateCallback) {
    this.log = log;
    this.config = {
      retryInterval,
      updateInterval,
      ...config,
    };
    this.updateCallback = updateCallback || (() => {});
    this.bound = false;
    this.status = {};
    
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket.on("message", (msg, rinfo) => {
      if (rinfo.address === config.address) {
        this._handleResponse(msg.toString());
      }
    });
    this.socket.on(
      "listening",
      this.config.mac ? this._init.bind(this) : this._scan.bind(this)
    );
    
    this.timer = new EventEmitter();
    this.timer.on("refresh", this._updateStatus.bind(this));
    
    this._connect();
  }

  _connect() {
    try {
      this.log.debug(`Setup socket`);
      this.socket.bind(() => {
        this.log.debug(`Socket setup at ${this.socket.address().port}`);
      });
    } catch (error) {
      this.log.error(error);
      const that = this;
      setTimeout(() => {
        that.log.error("Fail to setup socket, retrying...");
        that._connect();
      }, this.config.retryInterval);
    }
  }

  _retry(callback, message){
    const that = this;
    setTimeout(() => {
      if (that.bound === false) {
        that.log.error(message);
        callback();
      }
    }, this.config.retryInterval);
  }

  _init(){
    try {
      this.mac = this.config.mac;
      this._bind();
      this.log.debug(`Binding to device at ${this.config.address}:${this.config.port}(${this.mac})`);
    } catch (error) {
      this.log.error(error);
    }
    this._retry(
      this._init.bind(this),
      `Device not found at ${this.config.address}:${this.config.port}(${this.mac}), retrying...`
    );
  }

  _scan() {
    try {
      const msg = JSON.stringify({ t: "scan" });
      this.log.debug(`Scan for device at ${this.config.address}:${this.config.port}`);
      this.socket.send(msg, this.config.port, this.config.address);
    } catch (error) {
      this.log.error(error);
    }
    this._retry(
      this._scan.bind(this),
      `Device not found at ${this.config.address}:${this.config.port}, retrying...`
    );
  }

  _bind() {
    const message = {
      mac: this.mac,
      t: "bind",
      uid: 0,
    };
    this.log.debug(`Bind to device: ${this.mac}`);
    this._sendRequest(message);
  }

  _updateStatus() {
    const cols = Object.keys(commands).map(k => commands[k].code);
    const message = {
      mac: this.mac,
      t: "status",
      cols
    };
    this.log.debug(`[${this.mac}] Update status for keys: ${cols}`);
    this._sendRequest(message);
  }

  sendCommands(commands) {
    const keys = Object.keys(commands);
    const values = keys.map(k => commands[k]);
    const message = {
      t: "cmd",
      opt: keys,
      p: values,
    };
    this.log.debug(`[${this.mac}] Send commands: %j`, commands);
    this._sendRequest(message);
  }

  _sendRequest(message) {
    const pack = crypto.encrypt(message, this.key);
    const request = {
      cid: "app",
      i: this.key == null ? 1 : 0,
      t: "pack",
      uid: 0,
      pack,
    };
    const msg = JSON.stringify(request);
    this.log.debug(`[${this.mac}] Send request: %j`, message);
    try {
      this.socket.send(msg, this.config.port, this.config.address);
    } catch (error) {
      this.log.error(error);
    }
  }

  _handleResponse(message) {
    const pack = crypto.decrypt(JSON.parse(message).pack, this.key);
    switch (pack.t) {
      case "dev": // connect
        this.mac = pack.mac || pack.cid;
        this.log.debug(`Found device: ${this.mac}`);
        this._bind();
        break;
      case "bindok": // bound
        this.mac = pack.mac || pack.cid;
        this.key = pack.key;
        this.bound = true;
        this.log.info(`Bound to device: ${this.mac}`);
        setInterval(
          () => this.timer.emit("refresh"),
          this.config.updateInterval || updateInterval
        );
        break;
      case "dat": // status
        pack.cols.forEach((col, i) => {
          this.status[col] = pack.dat[i];
        });
        this.log.debug(`[${this.mac}] Status updated: %j`, this.status);
        this.updateCallback();
        break;
      case "res": // command response
        pack.opt.forEach((col, i) => {
          this.status[col] = (pack.val || pack.p)[i];
        });
        this.log.debug(`[${this.mac}] Command responded: %j`, this.status);
        this.updateCallback();
        break;
    }
  }
}

module.exports = Device;
    
