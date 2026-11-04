import test from 'node:test';
import assert from 'node:assert/strict';
import { localAddress, privateAddress } from '../src/server/private-address.js';

test('an address on this computer is found however it is written', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '0.0.0.0', '169.254.169.254', '::1', '0:0:0:0:0:0:0:1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1',
    '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'fe80::1', 'fe80::1%lo0', 'FE80::ABCD', 'not an address'])
    assert.equal(localAddress(address), true, address);
  // The local network and the internet are not this computer.
  for (const address of ['192.168.1.20', '10.0.0.5', '93.184.216.34', '::ffff:93.184.216.34', '2606:4700::1111', 'fd00::1'])
    assert.equal(localAddress(address), false, address);
  // Every local address is also private.
  for (const address of ['::ffff:7f00:1', '0:0:0:0:0:ffff:127.0.0.1', 'fe80::1']) assert.equal(privateAddress(address), true, address);
});
