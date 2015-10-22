/* jslint node: true */
'use strict';

//	ENiGMA½
var conf			= require('../config.js');
var baseClient		= require('../client.js');
var Log				= require('../logger.js').log;
var ServerModule	= require('../server_module.js').ServerModule;
var userLogin		= require('../user_login.js').userLogin;
var enigVersion 	= require('../../package.json').version;
var theme			= require('../theme.js');

var ssh2			= require('ssh2');
var fs				= require('fs');
var util			= require('util');
var _				= require('lodash');
var assert			= require('assert');

exports.moduleInfo = {
	name		: 'SSH',
	desc		: 'SSH Server',
	author		: 'NuSkooler',
	isSecure	: true,
};

exports.getModule		= SSHServerModule;

/*
	TODO's
	* Need to handle new user path
		=> [ new username(s) ] -> apply path -> 
		=> "new" or "apply" -> ....
*/

function SSHClient(clientConn) {
	baseClient.Client.apply(this, arguments);

	//
	//	WARNING: Until we have emit 'ready', self.input, and self.output and
	//	not yet defined!
	//

	var self = this;

	var loginAttempts = 0;

	clientConn.on('authentication', function authAttempt(ctx) {
		self.log.trace( { method : ctx.method, username : ctx.username }, 'SSH authentication attempt');

		var username	= ctx.username || '';
		var password	= ctx.password || '';

		function termConnection() {
			ctx.reject();
			clientConn.end();
		}

		if(username.length > 0 && password.length > 0) {
			loginAttempts += 1;

			userLogin(self, ctx.username, ctx.password, function authResult(err) {
				if(err) {
					if(err.existingConn) {
						//	:TODO: Can we display somthing here?
						termConnection();
						return;
					} else {
						return ctx.reject(SSHClient.ValidAuthMethods);
					}
				} else {
					ctx.accept();
				}
			});
		} else {
			if(-1 === SSHClient.ValidAuthMethods.indexOf(ctx.method)) {
				return ctx.reject(SSHClient.ValidAuthMethods);
			}

			console.log(ctx.method)

			if(0 === username.length) {
				//	:TODO: can we display something here?
				return ctx.reject();
			}

			var interactivePrompt = { prompt: ctx.username + '\'s password: ', echo : false };

			ctx.prompt(interactivePrompt, function retryPrompt(answers) {
				loginAttempts += 1;

				userLogin(self, username, (answers[0] || ''), function authResult(err) {
					if(err) {
						if(err.existingConn) {
							//	:TODO: can we display something here?
							termConnection();
						} else {				
							if(loginAttempts >= conf.config.general.loginAttempts) {
								termConnection();
							} else {
								var artOpts = {
									client		: self,
									name 		: 'SSHPMPT.ASC',
									readSauce	: false,
								};
								theme.getThemeArt(artOpts, function gotArt(err, artInfo) {
									if(err) {
										interactivePrompt.prompt = 'Access denied\n' + ctx.username + '\'s password: ';
									} else {
										var newUserNameList = '"' + (conf.config.users.newUserNames || []).join(', ') + '"';
										interactivePrompt.prompt = 
											'Access denied\n' + 
											artInfo.data.format( { newUserNames : newUserNameList } ) + 
											'\n' + ctx.username + '\'s password: ';
									}
									return ctx.prompt(interactivePrompt, retryPrompt);
								});
							}
						}
					} else {
						ctx.accept();
					}
				});	
			});		
		}
	});

	this.updateTermInfo = function(info) {
		//
		//	From ssh2 docs:
		//	"rows and cols override width and height when rows and cols are non-zero."
		//
		var termHeight;
		var termWidth;

		if(info.rows > 0 && info.cols > 0) {
			termHeight 	= info.rows;
			termWidth	= info.cols;
		} else if(info.width > 0 && info.height > 0) {
			termHeight	= info.height;
			termWidth	= info.width;
		}

		assert(_.isObject(self.term));

		//
		//	Note that if we fail here, connect.js attempts some non-standard
		//	queries/etc., and ultimately will default to 80x24 if all else fails
		//
		if(termHeight > 0 && termWidth > 0) {
			self.term.termHeight = termHeight;
			self.term.termWidth	= termWidth;
		}

		if(_.isString(info.term) && info.term.length > 0 && 'unknown' === self.term.termType) {
			self.setTermType(info.term);
		}
	};

	clientConn.once('ready', function clientReady() {
		self.log.info('SSH authentication success');

		clientConn.on('session', function sess(accept, reject) {
			
			var session = accept();

			session.on('pty', function pty(accept, reject, info) {
				self.log.debug(info, 'SSH pty event');

				if(_.isFunction(accept)) {
					accept();
				}

				if(self.input) {	//	do we have I/O?
					self.updateTermInfo(info);
				} else {
					self.cachedPtyInfo = info;
				}
			});

			session.on('shell', function shell(accept, reject) {
				self.log.debug('SSH shell event');

				var channel = accept();

				self.setInputOutput(channel.stdin, channel.stdout);

				channel.stdin.on('data', function clientData(data) {
					self.emit('data', data);
				});

				if(self.cachedPtyInfo) {
					self.updateTermInfo(self.cachedPtyInfo);
					delete self.cachedPtyInfo;
				}

				//	we're ready!
				self.emit('ready');
			});

			session.on('window-change', function windowChange(accept, reject, info) {
				self.log.debug(info, 'SSH window-change event');

				console.log('window-change: ' + accept)

				self.updateTermInfo(info);
			});

		});
	});

	clientConn.on('end', function clientEnd() {
		self.emit('end');	//	remove client connection/tracking
	});

	clientConn.on('error', function connError(err) {
		self.log.warn( { error : err.toString(), code : err.code }, 'SSH connection error');
	});
}

util.inherits(SSHClient, baseClient.Client);

SSHClient.ValidAuthMethods = [ 'password', 'keyboard-interactive' ];

function SSHServerModule() {
	ServerModule.call(this);
}

util.inherits(SSHServerModule, ServerModule);

SSHServerModule.prototype.createServer = function() {
	SSHServerModule.super_.prototype.createServer.call(this);

	var serverConf = {
		privateKey	: fs.readFileSync(conf.config.servers.ssh.rsaPrivateKey),
		ident		: 'enigma-bbs-' + enigVersion + '-srv',
		//	Note that sending 'banner' breaks at least EtherTerm!
		debug		: function debugSsh(dbgLine) { 
			if(true === conf.config.servers.ssh.debugConnections) {
				Log.trace('SSH: ' + dbgLine);
			}
		},
	};

	var server = ssh2.Server(serverConf);
	server.on('connection', function onConnection(conn, info) {
		Log.info(info, 'New SSH connection');

		var client = new SSHClient(conn);
		
		this.emit('client', client, conn._sock);
	});

	return server;
};
