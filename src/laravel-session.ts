// Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the GNU Affero General Public License v3.0.
// See the LICENCE file in the repository root for full licence text.

import * as crypto from 'crypto';
import * as http from 'http';
import * as url from 'url';
import { promisify } from 'util';
import * as cookie from 'cookie';
import { unserialize } from 'php-serialize';
import * as redis from 'redis';

interface Params {
  appKey: string;
  redisConfig: redis.ClientOpts;
}

interface EncryptedSession {
  iv: string;
  mac: string;
  value: string;
}

interface Session {
  csrf: string;
  key: string;
  requiresVerification: boolean;
  userId: number;
  verified: boolean;
}

function maybeEncryptedSession(arg: unknown): arg is Partial<EncryptedSession> {
  return typeof arg === 'object' && arg !== null;
}

function isEncryptedSession(arg: unknown): arg is EncryptedSession {
  return maybeEncryptedSession(arg) &&
    typeof arg.iv === 'string' &&
    typeof arg.value === 'string' &&
    typeof arg.mac === 'string';
}

const sessionCookieName = 'osu_session';

const getCookie = (req: http.IncomingMessage, key: string) => {
  if (req.headers.cookie != null) {
    return cookie.parse(req.headers.cookie)[key];
  }
};

export default class LaravelSession {
  private key: Buffer;
  private redis: redis.RedisClient;
  private redisGet: any;
  private sessionCookieNameHmac: Buffer;

  constructor(params: Params) {
    this.redis = redis.createClient(params.redisConfig);
    this.redisGet = promisify(this.redis.get).bind(this.redis);
    this.key = Buffer.from(params.appKey.slice('base64:'.length), 'base64');
    // https://github.com/laravel/framework/blob/208c3976f186dcdfa0a434f4092bae7d32928465/src/Illuminate/Cookie/CookieValuePrefix.php
    this.sessionCookieNameHmac = crypto.createHmac('sha1', this.key).update(`${sessionCookieName}v2`).digest();
  }

  async getSessionDataFromRequest(req: http.IncomingMessage): Promise<Session | null> {
    const key = this.keyFromSession(getCookie(req, sessionCookieName));

    if (key == null) {
      return null;
    }

    const serializedData = await this.redisGet(key);

    const rawData = unserialize(unserialize(serializedData), {}, {strict: false});

    // login_<authName>_<hashedAuthClass>
    const userId = rawData.login_web_59ba36addc2b2f9401580f014c7f58ea4e30989d;

    return {
      csrf: rawData._token,
      key,
      requiresVerification: rawData.requires_verification,
      userId,
      verified: rawData.verified,
    };
  }

  keyFromSession(session = '') {
    if (session == null || session === '') {
      return;
    }

    let encryptedSession: unknown;
    try {
      encryptedSession = JSON.parse(
        Buffer.from(session, 'base64').toString(),
      );
    } catch (err) {
      throw new Error('Failed parsing session data');
    }

    if (!isEncryptedSession(encryptedSession)) {
      throw new Error('Session data is missing required fields');
    }

    this.verifyHmac(encryptedSession);

    const keyWithCookieNameHmac = this.decrypt(encryptedSession);
    let key: string;

    // 40 = this.sessionCookieNameHmac.length
    if (/^[0-9a-f]{40}\|/.test(keyWithCookieNameHmac)) {
      const nameHmac = Buffer.from(keyWithCookieNameHmac.slice(0, 40), 'hex');

      if (!crypto.timingSafeEqual(this.sessionCookieNameHmac, nameHmac)) {
        throw new Error('Cookie name in session data failed HMAC verification');
      }

      // 41 = hmac + '|'
      key = keyWithCookieNameHmac.slice(41);
    } else {
      key = keyWithCookieNameHmac;
    }

    return `osu-next:${key}`;
  }

  async verifyRequest(req: http.IncomingMessage) {
    if (req.url == null) {
      return null;
    }

    const session = await this.getSessionDataFromRequest(req);

    if (session == null || session.userId == null) {
      return null;
    }

    const params = url.parse(req.url, true).query;

    if (typeof params.csrf !== 'string' || params.csrf === '') {
      throw new Error('missing csrf token');
    }

    const csrf = Buffer.from(params.csrf);

    let hasValidToken;

    try {
      hasValidToken = crypto.timingSafeEqual(Buffer.from(session.csrf), csrf);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'unknown';
      throw new Error(`failed checking csrf token: ${errorMessage}`);
    }

    if (hasValidToken) {
      return {
        key: session.key,
        requiresVerification: session.requiresVerification,
        scopes: new Set(['*']),
        userId: session.userId,
        verified: session.verified,
      };
    } else {
      throw new Error('invalid csrf token');
    }
  }

  private decrypt(encryptedSession: EncryptedSession) {
    const iv = Buffer.from(encryptedSession.iv, 'base64');
    const value = Buffer.from(encryptedSession.value, 'base64');
    const decrypter = crypto.createDecipheriv('AES-256-CBC', this.key, iv);

    return Buffer.concat([decrypter.update(value), decrypter.final()]).toString();
  }

  private verifyHmac(session: EncryptedSession) {
    const reference = Buffer.from(session.mac, 'hex');
    const computed = crypto
      .createHmac('sha256', this.key)
      .update(`${session.iv}${session.value}`)
      .digest();

    if (!crypto.timingSafeEqual(computed, reference)) {
      throw new Error('Session data failed HMAC verification');
    }
  }
}
