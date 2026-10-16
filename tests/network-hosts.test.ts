import { expect, it } from 'vitest';
import { isNonPublicHost } from '../src/main/network-hosts';

it('treats loopback, private, link-local and single-label hosts as non-public', () => {
  for (const host of [
    'localhost',
    'LOCALHOST.',
    'printer.local',
    'nas',
    'router.home.arpa',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.20',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '[::1]',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:192.168.0.1',
  ])
    expect(isNonPublicHost(host), host).toBe(true);
});

it('allows ordinary public hosts and addresses', () => {
  for (const host of ['huggingface.co', 'civitai.com', 'cdn-lfs.hf.co', '8.8.8.8', '172.32.0.1', '2606:4700::1111'])
    expect(isNonPublicHost(host), host).toBe(false);
});
