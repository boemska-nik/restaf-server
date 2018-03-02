
/*
 *  ------------------------------------------------------------------------------------
 *  * Copyright (c) SAS Institute Inc.
 *  *  Licensed under the Apache License, Version 2.0 (the "License");
 *  * you may not use this file except in compliance with the License.
 *  * You may obtain a copy of the License at
 *  *
 *  * http://www.apache.org/licenses/LICENSE-2.0
 *  *
 *  *  Unless required by applicable law or agreed to in writing, software
 *  * distributed under the License is distributed on an "AS IS" BASIS,
 *  * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  * See the License for the specific language governing permissions and
 *  limitations under the License.
 * ----------------------------------------------------------------------------------------
 *
 */

'use strict';

let debug          = require( 'debug' );
let debugProxy     = debug( 'proxy' );
let debugRouter    = debug( 'router' );
let proxyLogger    = debug( 'proxylogger' );
let responseLogger = debug( 'response' );
let server       = require( './server' );
let boom         = require( 'boom' );
let request      = require( 'request' );
/* require( 'request-debug' )( request ); */
let os           = require( 'os' );
let v8           = require( 'v8' );
let SASauth      = require( './SASauth' );
let qs           = require( 'qs' );
let uuid         = require( 'uuid' );

module.exports = function iService( uTable, useDefault , asset, rootHandler ){

    //
    // By default only the main entry is authenticated.
    // This is because EDGE seems to have some strange policies - it does not return authenticated info on
    // subsequent calls to the server. Cannot figure out why.
    // I also added caching of token - should not really need it once I figure out the EDGE use case.
    //
    function customConfig( a ) {
        let config = { handler: a };
        if ( ( process.env.hasOwnProperty ( 'SECONDARYROUTEOAUTH2' ) === false ) || process.env.SECONDARYROUTEOAUTH2 === 'NO' ){
            config.auth = false;
        }
        return config;
    }

    process.env.APPHOST = ( process.env.APPHOST === '*' ) ? os.hostname() : process.env.APPHOST;
    let appName = '/' + process.env.APPNAME;
    let auth1 = {};
    let auth2 = {};
    let handleOthers;
    if ( process.env.PROXYSERVER === 'YES' ){
        process.env.OAUTH2='YES';
    }
    console.log( `appName ${appName}` );
    console.log( `asset ${asset} ` );
    console.log( `uTable ${uTable}` );

    if ( process.env.OAUTH2 === 'YES' ) {
        auth1 = {
            mode    : 'required',
            strategy: 'sas'
        };
        auth2 = {
            mode    : 'try',
            strategy: 'session'
        };
    }
    else {
        auth1 = false;
        auth2 = false;
    }

    let defaultTable =
            [ {
                method: [ 'GET' ],
                path  : `${appName}`,
                config: {
                    auth   : auth1,
                    handler: ( process.env.OAUTH2 === 'YES' ) ? getAuthApp.bind( null, rootHandler ) : getApp
                }
            }, {
                method: [ 'GET' ],
                path  : `${appName}/{param*}`,
                config: customConfig( getApp2 )

            }, {
                method : [ 'GET' ],
                path   : `${appName}/callback`,
                handler: AppCallback

            }, {
                method: [ 'GET' ],
                path  : `/shared/{param*}`,
                config: customConfig( getShared )
            }, {
                method: [ 'GET' ],
                path  : '/favicon.ico',
                config: {
                    auth   : false,
                    handler: getIcon
                }
            }, {
                method: [ 'GET' ],
                path  : '/testserver',
                config: {
                    auth   : auth2,
                    handler: testServer
                }
            }
            ];

    // Tried payload.parse = false -- way too much code to handle payload
    if ( process.env.PROXYSERVER === 'YES' ) {
        handleOthers = {
            method: [ '*' ],
            path  : '/{params*}',
            config: {
                handler: handleProxy,
                auth   : auth2
            }
        };
        defaultTable = [ ...defaultTable, handleOthers ];
    } else {
        handleOthers = {
            method: [ 'GET' ],
            path  : '/{param*}',
            config: {
                handler: getApp2
            }
        };
        defaultTable = [ ...defaultTable, handleOthers ] ;
    }

    let userRouterTable;
    if ( uTable !== null ) {
        if ( useDefault === true ) {
            userRouterTable = [ ...defaultTable, ...uTable ];
        } else {
            userRouterTable = [ ...uTable ];
        }
    } else {
        userRouterTable = [ ...defaultTable ];
    }
    debugger;
    console.log( JSON.stringify( userRouterTable, null, 4 ) );
    server( userRouterTable, asset );

};

//
// Had to add cache to handle Edge browser - must be a way not to have to do this.
//
function testServer( req, reply ) {
    debugger;
    if ( process.env.OAUTH2 === 'YES' ) {
        getToken( req, reply, ( err, token ) => {
            if ( err ) {
                reply( boom.unauthorized( err ) )
            } else {
                reply.file( `testserver.html` );
            }
        } );
    } else {
        reply.file( 'testservernoauth.html' );
    }
}

function getToken ( req, reply , cb ) {
    debugger;
    if ( req.auth.credentials !== null ) {
        cb( null, req.auth.credentials.session );

    } else {
        req.server.app.cache.get( 'edge', ( err, credentials ) => {
            if ( err ) {
                cb( err, null );
            } else {
                cb( null, credentials.token );
            }
        } );
    }

}
function handleProxy( req, reply ) {
    debugger;
    getToken( req, reply, ( err, token ) => {
        if ( err ) {
            reply( boom.unauthorized( err ) )
        } else {
            handleProxyRequest( req, reply, token );
        }
    } );
}

function handleProxyRequest( req, reply, token ) {
    debugger;
    let uri   = `${process.env.SAS_PROTOCOL}${process.env.VIYA_SERVER}/${req.params.params}`;
    let headers = { ...req.headers };
    delete headers.host;
    delete headers[ 'user-agent' ];
    delete headers.origin;
    delete headers.referer;
    delete headers.connection;
    if ( headers.cookie ) {
        delete headers.cookie;
    }
    debugger;
    let config = {
        url    : uri,
        method : req.method,
        headers: headers,
        gzip   : true,
        auth   : {
            bearer: token
        }
    };


    if ( req.payload != null ) {
        debugProxy( console.log( headers['content-type'] ) );
        if ( headers['content-type'] === 'application/octet-stream' ) {
            config.body = req.payload;
        } else {
            config.body = ( typeof req.payload === 'object' ) ? JSON.stringify( req.payload ) : req.payload;
        }
    }

    if ( req.query !== null && Object.keys( req.query ).length > 0  ) {
        config.qs = req.query;
    }

    debugProxy( JSON.stringify( config, null, 4 ) );
    proxyLogger( config.url );
    request( config, ( err, response, body ) =>  {
        debugger;
        if ( err ) {
            console.log( 'Request failed' );
            console.log( err );
            console.log( JSON.stringify( err, null, 4 ) );
            reply ( err );
        } else {
            debugger;
            responseLogger( {url: `------------------------------------------${config.url}`} );
            responseLogger( req.query );
            responseLogger( ( typeof body === 'string' ? {body: body} : body ) );
            let headers = {...response.headers};
            if ( headers.hasOwnProperty( 'content-encoding' ) ) {
                delete headers['content-encoding'];
            }
            responseLogger( response.headers['content-coding'] );
            reply( body ).headers = {...headers };


        }
    } );
}


function getApp( req, reply ) {
    debugger;
    let path = `index.html`;
    reply.file( path );
}

function getIcon( req, reply ) {
    reply.file( 'favicon.ico' );
}

function getAuthApp( rootHandler, req, reply ) {
    debugger;
    if ( !req.auth.isAuthenticated ) {
        reply( boom.unauthorized( req.auth.error.message ) );
    } else {
        debugger;
        debugRouter( 'Logged on successfully' );

       req.cookieAuth.set( {session: req.auth.credentials.token } );

       req.server.app.cache.set( 'edge',  req.auth.credentials ) ;

        if ( rootHandler !== null ) {
            rootHandler( req, reply );
        } else {
            debugger;
            let indexHTML = ( process.env.APPENTRY == null ) ? 'index.html' : process.env.APPENTRY;
            reply.file( `${indexHTML}` );
        }
    }
}

function AppCallback(  req, reply ) {
    proxyLogger( 'In callback' );
    reply.file( `${process.env.CALLBACK}.html` );
}

function getApp2( req, reply ) {
    reply.file( req.params.param );
}

function getShared( req, reply ) {
    reply.file( `shared/${req.params.param}` );
}