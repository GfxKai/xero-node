/** @internalapi */
/** This second comment is required for typedoc to recognise the WHOLE FILE as @internalapi */

import { OAuth } from 'oauth';
import { IHttpClient } from './BaseAPIClient';
import * as fs from 'fs';
import * as querystring from 'querystring';
import * as http from 'http';
import * as https from 'https';
import { XeroHttpError, XeroAuthError } from '../XeroErrors';

export interface IToken {
	oauth_token: string;
	oauth_token_secret: string;
}

export interface IOAuth1State {
	requestToken: IToken;
	accessToken: IToken;
	oauth_session_handle: string;
	oauth_expires_at?: Date;
}

export interface IOAuth1Configuration {
	consumerKey: string;
	consumerSecret: string;

	apiBaseUrl: string;
	apiBasePath: string;
	oauthRequestTokenPath: string;
	oauthAccessTokenPath: string;

	signatureMethod: string;
	accept: string;
	userAgent: string;
	callbackUrl: string;
}

export interface IOAuth1Client {
	agent?: http.Agent;
	getState(): IOAuth1State;
	setState(state: Partial<IOAuth1State>): void;
	getUnauthorisedRequestToken(): Promise<void>;
	buildAuthoriseUrl(): string;
	swapRequestTokenforAccessToken(oauth_verifier: string): Promise<void>;
	refreshAccessToken(): Promise<void>;
}

export interface IOAuth1HttpClient extends IHttpClient, IOAuth1Client { }

export class OAuth1HttpClient implements IOAuth1HttpClient {

	private _state: IOAuth1State = {
		requestToken: null,
		accessToken: null,
		oauth_session_handle: null
	};

	private oauthLib: typeof OAuth;

	public agent: http.Agent;

	constructor(private config: IOAuth1Configuration, private oAuthLibFactory?: (config: IOAuth1Configuration) => typeof OAuth) {
		this._state = {
			requestToken: null,
			accessToken: null,
			oauth_session_handle: null
		};

		if (!this.oAuthLibFactory) {
			this.oAuthLibFactory = function(passedInConfig: IOAuth1Configuration) {
				return new OAuth(
					passedInConfig.apiBaseUrl + passedInConfig.oauthRequestTokenPath, 	// requestTokenUrl
					passedInConfig.apiBaseUrl + passedInConfig.oauthAccessTokenPath, 	// accessTokenUrl
					passedInConfig.consumerKey, 										// consumerKey
					passedInConfig.consumerSecret,										// consumerSecret
					'1.0A',																// version
					config.callbackUrl,													// authorize_callback
					passedInConfig.signatureMethod,										// signatureMethod. Neesds to ve "RSA-SHA1" for Private. "HMAC-SHA1" for public
					null,																// nonceSize
					{																	// customHeaders
						'Accept': passedInConfig.accept,
						'User-Agent': passedInConfig.userAgent
					}
				);
			};
		}

		this.oauthLib = this.oAuthLibFactory(this.config);
		this.oauthLib._createClient = this._createHttpClientWithProxySupport.bind(this);
	}

	public getUnauthorisedRequestToken = async () => {
		return new Promise<void>((resolve, reject) => {
			this.oauthLib.getOAuthRequestToken(
				(err: any, oauth_token: string, oauth_token_secret: string, result: any) => {
					if (err) {
						reject(new XeroAuthError(err.statusCode, err.data));
					} else {
						this.setState({
							requestToken: {
								oauth_token,
								oauth_token_secret
							}
						});
						resolve();
					}
				}
			);
		});
	}

	public buildAuthoriseUrl = () => {
		return `${this.config.apiBaseUrl}/oauth/Authorize?oauth_token=${this._state.requestToken.oauth_token}`; // TODO Check for callback URL
	}

	public swapRequestTokenforAccessToken = async (oauth_verifier: string) => {
		return new Promise<void>((resolve, reject) => {
			this.oauthLib.getOAuthAccessToken(
				this._state.requestToken.oauth_token,
				this._state.requestToken.oauth_token_secret,
				oauth_verifier,
				(err: any, oauth_token: string, oauth_token_secret: string, results: {oauth_expires_in: number, oauth_session_handle: string, oauth_authorization_expires_in: string, xero_org_muid: string}) => {
					if (err) {
						reject(new XeroAuthError(err.statusCode, err.data));
					} else {
						const currentMilliseconds = new Date().getTime();
						const expDate = new Date(currentMilliseconds + (results.oauth_expires_in * 1000));

						this.setState({
							accessToken: {
								oauth_token: oauth_token,
								oauth_token_secret: oauth_token_secret
							},
							oauth_session_handle: results.oauth_session_handle,
							oauth_expires_at: expDate
						});
						resolve();
					}
				}
			);
		});

	}

	public refreshAccessToken = async () => {
		return new Promise<void>((resolve, reject) => {
			// We're accessing this "private" method as the lib does not allow refresh with oauth_session_handle.
			this.oauthLib._performSecureRequest(
				this._state.accessToken.oauth_token,
				this._state.accessToken.oauth_token_secret,
				'POST',
				this.config.apiBaseUrl + this.config.oauthAccessTokenPath,
				{ oauth_session_handle: this._state.oauth_session_handle },
				null,
				null,
				(err: any, data: string) => {
					if (err) {
						reject(new XeroAuthError(err.statusCode, err.data));
					} else {
						const results = querystring.parse(data);
						const newAccessToken: IToken = {
							oauth_token: results.oauth_token as string,
							oauth_token_secret: results.oauth_token_secret as string
						};
						this.setState({ accessToken: newAccessToken, oauth_session_handle: results.oauth_session_handle as string });
						resolve();
					}
				}
			);
		});
	}

	public writeResponseToStream = (endpoint: string, mimeType: string, writeStream: fs.WriteStream): Promise<void> => {
		const oauthForPdf = this.oAuthLibFactory({ ...this.config, ...{ accept: mimeType } });

		return new Promise<void>((resolve, reject) => {
			const request = oauthForPdf.get(
				this.config.apiBaseUrl + this.config.apiBasePath + endpoint,
				this._state.accessToken.oauth_token,
				this._state.accessToken.oauth_token_secret);

			request.addListener('response', function(response: any) {
				response.addListener('data', function(chunk: any) {
					writeStream.write(chunk);
				});
				response.addListener('end', function() {
					writeStream.end();
					writeStream.close();
					resolve();
				});
			});
			request.end();
		});
	}

	public get = async <T>(endpoint: string, acceptType?: string): Promise<T> => {
		return new Promise<T>((resolve, reject) => {
			this.assertAccessTokenIsSet();
			this.oauthLib.get(
				this.config.apiBaseUrl + this.config.apiBasePath + endpoint, // url
				this._state.accessToken.oauth_token,
				this._state.accessToken.oauth_token_secret,
				(err: object, data: string, httpResponse: any) => {
					// data is the body of the response

					if (err) {
						reject(new XeroHttpError(httpResponse.statusCode, data));
					} else {
						const toReturn = JSON.parse(data) as T;
						// toReturn.httpResponse = httpResponse; // We could add http data - do we want to?
						return resolve(toReturn);
					}
				}
			);
		});
	}

	public put = async <T>(endpoint: string, body: object): Promise<T> => {
		// this.checkAuthentication();
		this.assertAccessTokenIsSet();
		return new Promise<T>((resolve, reject) => {
			this.oauthLib.put(
				this.config.apiBaseUrl + this.config.apiBasePath + endpoint, // url
				this._state.accessToken.oauth_token,
				this._state.accessToken.oauth_token_secret,
				JSON.stringify(body), 		// Had to do this not sure if there is another way
				'application/json',
				(err: any, data: string, httpResponse: any) => {
					// data is the body of the response

					if (err) {
						reject(new XeroHttpError(httpResponse.statusCode, data));
					} else {
						const toReturn = JSON.parse(data) as T;
						// toReturn.httpResponse = httpResponse; // We could add http data - do we want to?
						return resolve(toReturn);
					}
				}
			);

		});
	}

	public post = async <T>(endpoint: string, body: object): Promise<T> => {
		this.assertAccessTokenIsSet();
		return new Promise<T>((resolve, reject) => {
			this.oauthLib.post(
				this.config.apiBaseUrl + this.config.apiBasePath + endpoint, // url
				this._state.accessToken.oauth_token,
				this._state.accessToken.oauth_token_secret,
				JSON.stringify(body), 		// Had to do this not sure if there is another way
				'application/json',
				(err: any, data: string, httpResponse: any) => {
					// data is the body of the response

					if (err) {
						reject(new XeroHttpError(httpResponse.statusCode, data));
					} else {
						const toReturn = JSON.parse(data) as T;
						// toReturn.httpResponse = httpResponse; // We could add http data - do we want to?
						return resolve(toReturn);
					}
				}
			);

		});
	}

	public delete = async <T>(endpoint: string): Promise<T> => {
		this.assertAccessTokenIsSet();
		return new Promise<T>((resolve, reject) => {
			this.oauthLib.delete(
				this.config.apiBaseUrl + this.config.apiBasePath + endpoint, // url
				this._state.accessToken.oauth_token,
				this._state.accessToken.oauth_token_secret,
				(err: any, data: string, httpResponse: any) => {
					// data is the body of the response

					if (err) {
						reject(new XeroHttpError(httpResponse.statusCode, data));
					} else {
						let toReturn: T = null;
						if (data) {
							toReturn = JSON.parse(data) as T;
						}

						// toReturn.httpResponse = httpResponse; // We could add http data - do we want to?
						return resolve(toReturn);
					}
				}
			);
		});
	}

	public getState() {
		return this._state;
	}

	public setState(newState: Partial<IOAuth1State>) {
		this._state = { ...this._state, ...newState };
	}

	private assertAccessTokenIsSet() {
		if (!this._state.accessToken) {
			throw new Error('Missing access token. Acquire a new access token by following the oauth flow or call setState() to use an existing token.');
		}
	}

	// Monkey-patched OAuthLib _createClient function to add proxy support
	private _createHttpClientWithProxySupport(
		port: number,
		hostname: string,
		method: string,
		path: string,
		headers: any,
		sslEnabled?: boolean) {
		const options: http.RequestOptions = {
			host: hostname,
			port: port,
			path: path,
			method: method,
			headers: headers
		};
		const httpModel: any = sslEnabled ? https : http;
		if (this.agent) {
			options.agent = this.agent;
		}
		return httpModel.request(options);
	}
}
