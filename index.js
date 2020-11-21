#!/usr/bin/env node
/* eslint-disable func-names */
/* eslint-disable func-name-matching */
/* eslint-disable camelcase */

/* eslint prefer-rest-params: "warn" */
/* eslint prefer-destructuring: "warn" */

/* eslint node/no-deprecated-api: "warn" */

const pkg = require('./package.json');
const log = require('yalm');
const config = require('yargs')
    .env(pkg.name.replace(/[^a-zA-Z\d]/, '_').toUpperCase())
    .usage('Usage: $0 [options]')
    .describe('verbosity', 'possible values: "error", "warn", "info", "debug"')
    .describe('name', 'instance name. used as mqtt client id and as prefix for connected topic')
    .describe('url', 'mqtt broker url. See https://github.com/mqttjs/MQTT.js#connect-using-a-url')
    .describe('help', 'show help')
    .describe('dir', 'directory to scan for .js and .coffee files. can be used multiple times.')
    .describe('disable-watch', 'disable file watching (don\'t exit process on file changes)')
    .alias({
        c: 'config',
        d: 'dir',
        h: 'help',
        n: 'name',
        u: 'url',
        v: 'verbosity',
        w: 'disable-watch'

    })
    .default({
        url: 'mqtt://host.docker.internal',
        name: 'logic',
        verbosity: 'info',
        'disable-watch': false,
        dir: '/scripts'
    })
    .config('config')
    .version()
    .help('help')
    .argv;
const mqttWildcard = require('mqtt-wildcard');
const oe = require('obj-ease');

/* istanbul ignore next */
log.setLevel(['debug', 'info', 'warn', 'error'].indexOf(config.verbosity) === -1 ? 'info' : config.verbosity);
log.info(pkg.name + ' ' + pkg.version + ' starting');
log.debug('loaded config: ', config);

const modules = {
    fs: require('fs'),
    path: require('path'),
    vm: require('vm'),
    /* eslint-disable no-restricted-modules */
    domain: require('domain'),
    mqtt: require('mqtt'),
    watch: require('watch'),
    'node-schedule': require('node-schedule')
};

const domain = modules.domain;
const vm = modules.vm;
const fs = modules.fs;
const path = modules.path;
const watch = modules.watch;
const scheduler = modules['node-schedule'];

const sandboxModules = [];
const status = {};
const scripts = {};
const subscriptions = [];

const _global = {};

// MQTT
const mqtt = modules.mqtt.connect(config.url, {will: {topic: config.name + '/online', payload: 'false', retain: true}});
mqtt.publish(config.name + '/online', 'true', {retain: true});

let firstConnect = true;
let startTimeout;
let connected;

mqtt.on('connect', () => {
    connected = true;
    log.info('mqtt connected ' + config.url);
    log.debug('mqtt subscribe #');
    mqtt.subscribe('#');
    if (firstConnect) {
        // Wait until retained topics are received before we load the scripts (timeout is prolonged on incoming retained messages)
        startTimeout = setTimeout(start, 500);
    }
});

mqtt.on('close', () => {
    if (connected) {
        firstConnect = false;
        connected = false;
        log.info('mqtt closed ' + config.url);
    }
});

/* istanbul ignore next */
mqtt.on('error', () => {
    log.error('mqtt error ' + config.url);
});

mqtt.on('message', (topic, payload, msg) => {
    if (firstConnect && msg.retain) {
        // Retained message received - prolong the timeout
        clearTimeout(startTimeout);
        startTimeout = setTimeout(start, 500);
    }

    payload = payload.toString();

    let state;

    // Parse Payload
    try {
        state = _parsePayload(payload);
    } catch (e) {

    }

    const oldState = status[topic];
    oe.extend(status, {[topic]: state});

    subscriptions.forEach(subs => {
        const options = subs.options || {};
        let delay;

        const match = mqttWildcard(topic, subs.topic);

        if (match && typeof options.condition === 'function') {
            if (!options.condition(topic, state, oldState)) {
                return;
            }
        }

        if (match && typeof subs.callback === 'function') {
            if (msg.retain && !options.retain) {
                return;
            }
            if (options.change && (state === oldState)) {
                return;
            }

            delay = 0;
            if (options.shift) {
                delay += ((parseFloat(options.shift) || 0) * 1000);
            }
            if (options.random) {
                delay += ((parseFloat(options.random) || 0) * Math.random() * 1000);
            }

            delay = Math.floor(delay);

            setTimeout(() => {
                /**
                 * @callback subscribeCallback
                 * @param {string} topic - the topic that triggered this callback. +/status/# will be replaced by +//#
                 * @param {mixed} val - the val property of the new state
                 * @param {object} obj - new state - the whole state object (e.g. {"val": true, "ts": 12346345, "lc": 12346345} )
                 * @param {object} objPrev - previous state - the whole state object
                 * @param {object} msg - the mqtt message as received from MQTT.js
                 */
                subs.callback(topic, state, oldState);
            }, delay);
        }
    });
});

function _parsePayload(payload) {
    try {
        return JSON.parse(payload);
    } catch {
        try {
            return String(payload);
        } catch {
            throw new Error('Unable to parse MQTT payload.');
        }
    }
}

function createScript(source, name) {
    log.debug(name, 'compiling');
    try {
        return new vm.Script(source, {filename: name});
    } catch (err) {
        log.error(name, err.name + ':', err.message);
        return false;
    }
}

function runScript(script, name) {
    const scriptDir = path.dirname(path.resolve(name));

    log.debug(name, 'creating domain');
    const scriptDomain = domain.create();

    log.debug(name, 'creating sandbox');

    const Sandbox = {

        global: _global,

        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,

        Buffer,

        require(md) {
            if (modules[md]) {
                return modules[md];
            }
            try {
                let tmp;
                if (md.match(/^\.\//) || md.match(/^\.\.\//)) {
                    tmp = './' + path.relative(__dirname, path.join(scriptDir, md));
                } else {
                    tmp = md;
                    if (fs.existsSync(path.join(scriptDir, 'node_modules', md, 'package.json'))) {
                        tmp = './' + path.relative(__dirname, path.join(scriptDir, 'node_modules', md));
                        tmp = path.resolve(tmp);
                    }
                }
                Sandbox.log.debug('require', tmp);
                modules[md] = require(tmp);
                return modules[md];
            } catch (err) {
                const lines = err.stack.split('\n');
                const stack = [];
                lines.forEach(line => {
                    if (!line.match(/module\.js:/) && !line.match(/index\.js:307/)) {
                        stack.push(line);
                    }
                });
                log.error(name + ': ' + stack);
            }
        },

        /**
         * @class log
         * @classdesc Log to stdout/stderr. Messages are prefixed with a timestamp and the calling scripts path.
         */
        log: {
            /**
             * Log a debug message
             * @memberof log
             * @method debug
             * @param {...*}
             */
            debug() {
                if (typeof arguments[0] == 'string') {
                    // Preserves behaiviour in case of printf-like strings: "count: %d - yeah!"
                    arguments[0] = name + ': ' + arguments[0];
                    log.debug.apply(log, arguments);
                } else {
                    // Takes care of any other case
                    // https://gist.github.com/robatron/5681424
                    var args = Array.prototype.slice.call(arguments);
                    args.unshift(name);
                    log.debug.apply(log, args);
                }
            },
            /**
             * Log an info message
             * @memberof log
             * @method info
             * @param {...*}
             */
            info() {
                if (typeof arguments[0] == 'string') {
                    // Preserves behaiviour in case of printf-like strings: "count: %d - yeah!"
                    arguments[0] = name + ': ' + arguments[0];
                    log.info.apply(log, arguments);
                } else {
                    // Takes care of any other case
                    // https://gist.github.com/robatron/5681424
                    var args = Array.prototype.slice.call(arguments);
                    args.unshift(name);
                    log.info.apply(log, args);
                }
            },
            /**
             * Log a warning message
             * @memberof log
             * @method warn
             * @param {...*}
             */
            warn() {
                if (typeof arguments[0] == 'string') {
                    // Preserves behaiviour in case of printf-like strings: "count: %d - yeah!"
                    arguments[0] = name + ': ' + arguments[0];
                    log.warn.apply(log, arguments);
                } else {
                    // Takes care of any other case
                    // https://gist.github.com/robatron/5681424
                    var args = Array.prototype.slice.call(arguments);
                    args.unshift(name);
                    log.warn.apply(log, args);
                }
            },
            /**
             * Log an error message
             * @memberof log
             * @method error
             * @param {...*}
             */
            error() {
                if (typeof arguments[0] == 'string') {
                    // Preserves behaiviour in case of printf-like strings: "count: %d - yeah!"
                    arguments[0] = name + ': ' + arguments[0];
                    log.error.apply(log, arguments);
                } else {
                    // Takes care of any other case
                    // https://gist.github.com/robatron/5681424
                    var args = Array.prototype.slice.call(arguments);
                    args.unshift(name);
                    log.error.apply(log, args);
                }
            }
        },
        /**
         * Subscribe to MQTT topic(s)
         * @method subscribe
         * @param {(string|string[])} topic - topic or array of topics to subscribe
         * @param {Object|string|function} [options] - Options object or as shorthand to options.condition a function or string
         * @param {number} [options.shift] - delay execution in seconds. Has to be positive
         * @param {number} [options.random] - random delay execution in seconds. Has to be positive
         * @param {boolean} [options.change] - if set to true callback is only called if val changed
         * @param {boolean} [options.retain] - if set to true callback is also called on retained messages
         * @param {(string|function)} [options.condition] - conditional function or condition string
         * @param {subscribeCallback} callback
         */
        subscribe: function Sandbox_subscribe(topic, /* optional */ options, callback) {
            if (typeof topic === 'undefined') {
                throw (new TypeError('argument topic missing'));
            }

            if (arguments.length === 2) {
                if (typeof arguments[1] !== 'function') {
                    throw new TypeError('callback is not a function');
                }

                callback = arguments[1];
                options = {};
            } else if (arguments.length === 3) {
                if (typeof arguments[2] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                options = arguments[1] || {};

                if (typeof options === 'string' || typeof options === 'function') {
                    options = {condition: options};
                }

                callback = arguments[2];
            } else if (arguments.length > 3) {
                throw (new Error('wrong number of arguments'));
            }

            if (typeof topic === 'string') {
                if (typeof options.condition === 'string') {
                    if (options.condition.indexOf('\n') !== -1) {
                        throw new Error('options.condition string must be one-line javascript');
                    }
                    /* eslint-disable no-new-func */
                    options.condition = new Function('topic', 'state', 'oldState', 'return ' + options.condition + ';');
                }

                if (typeof options.condition === 'function') {
                    options.condition = scriptDomain.bind(options.condition);
                }

                subscriptions.push({topic, options, callback: (typeof callback === 'function') && scriptDomain.bind(callback)});

                if (options.retain && status[topic] && typeof callback === 'function') {
                    callback(topic, status[topic]);
                } else if (options.retain && (/\/\+\//.test(topic) || /\+$/.test(topic) || /\+/.test(topic) || topic.endsWith('#')) && typeof callback === 'function') {
                    for (const t in status) {
                        if (mqttWildcard(t, topic)) {
                            callback(t, status[t]);
                        }
                    }
                }
            } else if (typeof topic === 'object' && Symbol.iterator in topic) {
                for (const tp of topic) {
                    Sandbox.subscribe(tp, options, callback);
                }
            }
        },
        /**
         * Schedule recurring and one-shot events
         * @method schedule
         * @param {(string|Date|Object|mixed[])} pattern - pattern or array of patterns. May be cron style string, Date object or node-schedule object literal. See {@link https://github.com/tejasmanohar/node-schedule/wiki}
         * @param {Object} [options]
         * @param {number} [options.random] - random delay execution in seconds. Has to be positive
         * @param {function} callback - is called with no arguments
         * @example // every full Hour.
         * schedule('0 * * * *', callback);
         *
         * // Monday till friday, random between 7:30am an 8:00am
         * schedule('30 7 * * 1-5', {random: 30 * 60}, callback);
         *
         * // once on 21. December 2018 at 5:30am
         * schedule(new Date(2018, 12, 21, 5, 30, 0), callback);
         *
         * // every Sunday at 2:30pm
         * schedule({hour: 14, minute: 30, dayOfWeek: 0}, callback);
         */
        schedule: function Sandbox_schedule(pattern, /* optional */ options, callback) {
            if (arguments.length === 2) {
                if (typeof arguments[1] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                callback = arguments[1];
                options = {};
            } else if (arguments.length === 3) {
                if (typeof arguments[2] !== 'function') {
                    throw new TypeError('callback is not a function');
                }
                options = arguments[1] || {};
                callback = arguments[2];
            } else {
                throw (new Error('wrong number of arguments'));
            }

            if (typeof pattern === 'object' && pattern.length > 0) {
                pattern = Array.prototype.slice.call(pattern);
                pattern.forEach(pt => {
                    Sandbox.schedule(pt, options, callback);
                });
                return;
            }

            if (options.random) {
                scheduler.scheduleJob(pattern, () => {
                    setTimeout(scriptDomain.bind(callback), (parseFloat(options.random) || 0) * 1000 * Math.random());
                });
            } else {
                scheduler.scheduleJob(pattern, scriptDomain.bind(callback));
            }
        },
        /**
         * Publish a MQTT message
         * @method publish
         * @param {(string|string[])} topic - topic or array of topics to publish to
         * @param {(string|Object)} payload - the payload string. If an object is given it will be JSON.stringified
         * @param {Object} [options] - the options to publish with
         * @param {number} [options.qos=0] - QoS Level
         * @param {boolean} [options.retain=false] - retain flag
         */
        publish: function Sandbox_publish(topic, payload, options) {
            if (typeof topic === 'object' && topic.length > 0) {
                topic = Array.prototype.slice.call(topic);
                topic.forEach(tp => {
                    Sandbox.publish(tp, payload, options);
                });
                return;
            }

            if (typeof payload === 'object') {
                payload = JSON.stringify(payload);
            } else {
                payload = String(payload);
            }
            mqtt.publish(topic, payload, options);
        },
        /**
         * @method status
         * @param {string} topic
         * @returns {mixed} the topics value
         */
        status: function Sandbox_getValue(topic) {
            return status[topic];
        }
    };

    Sandbox.console = {
        log: Sandbox.log.info,
        error: Sandbox.log.error
    };

    sandboxModules.forEach(md => {
        md(Sandbox);
    });

    log.debug(name, 'contextifying sandbox');
    const context = vm.createContext(Sandbox);

    scriptDomain.on('error', e => {
        /* istanbul ignore if */
        if (!e.stack) {
            log.error([name + ' unkown exception']);
            return;
        }
        const lines = e.stack.split('\n');
        const stack = [];
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/at ContextifyScript.Script.runInContext/)) {
                break;
            }
            stack.push(lines[i]);
        }

        log.error([name + ' ' + stack.join('\n')]);
    });

    scriptDomain.run(() => {
        log.debug(name, 'running');
        script.runInContext(context);
    });
}

function loadScript(file) {
    /* istanbul ignore if */
    if (scripts[file]) {
        log.error(file, 'already loaded?!');
        return;
    }

    log.info(file, 'loading');
    fs.readFile(file, (err, src) => {
        /* istanbul ignore if */
        if (err && err.code === 'ENOENT') {
            log.error(file, 'not found');
        } else if (err) {
            /* istanbul ignore next */
            log.error(file, err);
        } else {
            if (file.match(/\.coffee$/)) {
                if (!modules['coffee-compiler']) {
                    log.info('loading coffee-compiler');
                    modules['coffee-compiler'] = require('coffee-compiler2');
                }

                log.debug(file, 'transpiling');
                modules['coffee-compiler'].fromSource(src.toString(), {sourceMap: false, bare: true}, (err, js) => {
                    /* istanbul ignore if */
                    if (err) {
                        log.error(file, 'transpile failed', err.message);
                        return;
                    }
                    scripts[file] = createScript(js, file);
                });
            } else if (file.match(/\.js$/)) {
                // Javascript
                scripts[file] = createScript(src, file);
            }
            if (scripts[file]) {
                runScript(scripts[file], file);
            }
        }
    });
}

function loadSandbox(callback) {
    const dir = path.join(__dirname, 'sandbox');
    fs.readdir(dir, (err, data) => {
        /* istanbul ignore if */
        if (err) {
            if (err.errno === 34) {
                log.error('directory ' + path.resolve(dir) + ' not found');
            } else {
                log.error('readdir', dir, err);
            }
        } else {
            data.sort().forEach(file => {
                if (file.match(/\.js$/)) {
                    sandboxModules.push(require(path.join(dir, file)));
                }
            });

            if (!config.disableWatch) {
                watch.watchTree(dir, {
                    filter(path) {
                        return path.match(/\.js$/);
                    }
                }, (f, curr, prev) => {
                    if (typeof f === 'object' && prev === null && curr === null) {
                        log.debug('watch', dir, 'initialized');
                    } else {
                        watch.unwatchTree(dir);
                        log.info(f, 'change detected. exiting.');
                        process.exit(0);
                    }
                });
            }

            callback();
        }
    });
}

function loadDir(dir) {
    fs.readdir(dir, (err, data) => {
        /* istanbul ignore if */
        if (err) {
            if (err.errno === 34) {
                log.error('directory ' + path.resolve(dir) + ' not found');
            } else {
                log.error('readdir', dir, err);
            }
        } else {
            data.sort().forEach(file => {
                if (file.match(/\.(js|coffee)$/)) {
                    loadScript(path.join(dir, file));
                }
            });

            if (!config.disableWatch) {
                watch.watchTree(dir, {
                    filter(path) {
                        return path.match(/\.(js|coffee)$/);
                    }
                }, (f, curr, prev) => {
                    if (typeof f === 'object' && prev === null && curr === null) {
                        log.debug('watch', dir, 'initialized');
                    } else {
                        watch.unwatchTree(dir);
                        log.info(f, 'change detected. exiting.');
                        process.exit(0);
                    }
                });
            }
        }
    });
}

function start() {
    /* istanbul ignore if */
    if (config.file) {
        if (typeof config.file === 'string') {
            loadScript(config.file);
        } else {
            config.file.forEach(file => {
                loadScript(file);
            });
        }
    }

    loadSandbox(() => {
        if (config.dir) {
            /* istanbul ignore else */
            if (typeof config.dir === 'string') {
                loadDir(config.dir);
            } else {
                config.dir.forEach(dir => {
                    loadDir(dir);
                });
            }
        }
    });
}

/* istanbul ignore next */
process.on('SIGINT', () => {
    log.info('got SIGINT. exiting.');
    process.exit(0);
});
/* istanbul ignore next */
process.on('SIGTERM', () => {
    log.info('got SIGTERM. exiting.');
    process.exit(0);
});
