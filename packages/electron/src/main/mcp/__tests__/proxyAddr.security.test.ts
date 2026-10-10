// @vitest-environment node
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

const rootRequire = createRequire(new URL('../../../../../../package.json', import.meta.url));
const remoteRequire = createRequire(new URL('../../../../../../node_modules/mcp-remote/package.json', import.meta.url));
type Trust = (address: string, index?: number) => boolean;
const proxyaddr = rootRequire('proxy-addr') as { compile: (subnets: string | string[]) => Trust };

const unsafeMatches = [
  ['::ffff:10.0.0.0/8', '192.0.2.5'],
  ['::ffff:10.0.0.0/8', '::ffff:192.0.2.5'],
  ['::/1', '192.0.2.5'],
  ['::/1', '::ffff:192.0.2.5'],
  ['::ffff:10.0.0.0/80', '::1'],
];

for (const multiple of [false, true]) {
  const subnets = (subnet: string) => multiple ? [subnet, '2001:db8::/32'] : subnet;
  describe(multiple ? 'multiple trust subnets' : 'single trust subnet', () => {
    for (const [subnet, candidate] of unsafeMatches) {
      it(`does not trust ${subnet} for cross-family candidate ${candidate}`, () => {
        assert.strictEqual(proxyaddr.compile(subnets(subnet))(candidate), false);
      });
    }

    for (const [subnet, candidate, trusted] of [
      ['10.0.0.0/8', '10.2.3.4', true],
      ['10.0.0.0/8', '192.0.2.5', false],
      ['10.0.0.0/8', '::ffff:10.2.3.4', true],
      ['10.0.0.0/8', '::ffff:192.0.2.5', false],
      ['::ffff:10.0.0.0/104', '10.2.3.4', true],
      ['::ffff:10.0.0.0/104', '::ffff:10.2.3.4', true],
      ['::ffff:10.0.0.0/104', '192.0.2.5', false],
      ['::ffff:10.0.0.0/104', '::ffff:192.0.2.5', false],
      ['::ffff:0.0.0.0/96', '192.0.2.5', true],
      ['::ffff:0.0.0.0/96', '::ffff:192.0.2.5', true],
      ['::ffff:0.0.0.0/96', '::1', false],
      ['2001:db8:1::/48', '2001:db8:1::5', true],
      ['2001:db8:1::/48', '2001:db9::5', false],
      ['loopback', '127.2.3.4', true],
      ['loopback', '::1', true],
      ['loopback', '::ffff:127.0.0.1', true],
      ['loopback', '192.0.2.5', false],
      ['10.0.0.0/8', 'not-an-address', false],
    ] as const) {
      it(`preserves subnet ${subnet} / candidate ${candidate} => ${trusted}`, () => {
        assert.strictEqual(proxyaddr.compile(subnets(subnet))(candidate), trusted);
      });
    }
  });
}

it('an empty subnet list trusts no candidate', () => {
  const trust = proxyaddr.compile([]);
  for (const candidate of ['192.0.2.5', '::ffff:192.0.2.5', '::1', 'not-an-address']) {
    assert.strictEqual(trust(candidate), false);
  }
});

for (const subnet of ['not-a-subnet', '10.0.0.0/33', '::1/129']) {
  it(`invalid subnet ${subnet} throws during construction`, () => {
    assert.throws(() => proxyaddr.compile(subnet), TypeError);
  });
}

interface InertRequest { ip: string; ips: string[] }
interface InertApp {
  request: object;
  get(name: string): unknown;
  set(name: string, value: string | number | Trust): void;
}
type ExpressFactory = () => InertApp;

for (const [label, load] of [['Express 5', rootRequire], ['Express 4 under mcp-remote', remoteRequire]] as const) {
  const express = load('express') as ExpressFactory;
  const expressRequire = createRequire(load.resolve('express'));
  describe(label, () => {
    it('request and compileTrust resolve the same root proxy leaf', () => {
      for (const file of ['express/lib/request.js', 'express/lib/utils.js']) {
        assert.strictEqual(createRequire(load.resolve(file)).resolve('proxy-addr'), rootRequire.resolve('proxy-addr'));
      }
      assert.strictEqual(expressRequire('proxy-addr'), proxyaddr);
    });

    const requestFor = (app: InertApp) => Object.assign(Object.create(app.request), {
      app,
      socket: { remoteAddress: '192.0.2.10' },
      headers: { 'x-forwarded-for': '198.51.100.7, 192.0.2.20' },
    }) as InertRequest;

    it('default false ignores the synthetic forwarded chain', () => {
      const app = express();
      assert.strictEqual(app.get('trust proxy'), false);
      const request = requestFor(app);
      assert.strictEqual(request.ip, '192.0.2.10');
      assert.deepStrictEqual(request.ips, []);
    });

    for (const [policy, ip, ips] of [
      ['192.0.2.0/24', '198.51.100.7', ['198.51.100.7', '192.0.2.20']],
      ['203.0.113.0/24', '192.0.2.10', []],
      [1, '192.0.2.20', ['192.0.2.20']],
      [2, '198.51.100.7', ['198.51.100.7', '192.0.2.20']],
    ] as const) {
      it(`real getters honor trust policy ${policy}`, () => {
        const app = express();
        app.set('trust proxy', policy);
        const request = requestFor(app);
        assert.strictEqual(request.ip, ip);
        assert.deepStrictEqual(request.ips, ips);
        if (typeof policy === 'number') {
          const trust = app.get('trust proxy fn') as Trust;
          assert.strictEqual(trust('203.0.113.5', policy - 1), true);
          assert.strictEqual(trust('192.0.2.10', policy), false);
        }
      });
    }

    it('passes the custom function through and supplies addresses with hop indices', () => {
      const app = express();
      const calls: [string, number | undefined][] = [];
      const trust: Trust = (address, index) => {
        calls.push([address, index]);
        return index === 0 && address === '192.0.2.10';
      };
      app.set('trust proxy', trust);
      assert.strictEqual(app.get('trust proxy fn'), trust);
      const request = requestFor(app);
      assert.strictEqual(request.ip, '192.0.2.20');
      assert.deepStrictEqual(calls, [['192.0.2.10', 0], ['192.0.2.20', 1]]);
      calls.length = 0;
      assert.deepStrictEqual(request.ips, ['192.0.2.20']);
      assert.deepStrictEqual(calls, [['192.0.2.10', 0], ['192.0.2.20', 1]]);
    });
  });
}
