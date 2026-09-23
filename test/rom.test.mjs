// Kontroll over rommet: at en omlastet fane ikke blir staaende som et
// spokelse, at bare den med koden kan stoppe strommen eller kaste ut noen, at
// koden taaler store bokstaver, og at en ugyldig adresse ikke tar ned serveren.
//
// Kjor med:  SHARE_KEY=Humle PORT=8096 node server.js
//            node test/rom.test.mjs
import WebSocket from 'ws';
import http from 'node:http';

const PORT = Number(process.env.PORT) || 8096;
const URL = `ws://127.0.0.1:${PORT}`;
let fail = 0;
const check = (ok, w) => { console.log(`  [${ok ? ' OK ' : 'FEIL'}] ${w}`); if (!ok) fail++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

function open(headers = {}) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(URL, { headers });
    ws.inbox = []; ws.lyd = 0; ws.closeCode = null;
    ws.on('message', (d, bin) => {
      if (bin) { ws.lyd++; return; }
      try { ws.inbox.push(JSON.parse(d)); } catch {}
    });
    ws.on('close', (code) => { ws.closeCode = code; });
    ws.on('open', () => res(ws));
    ws.on('error', rej);
  });
}
const last = (ws, t) => [...ws.inbox].reverse().find(m => m.type === t);
const j = (ws, o) => ws.send(JSON.stringify(o));
const pakke = () => Buffer.from(new Uint8Array(64));

console.log('\nRomkode');
{
  const a = await open();
  j(a, { type: 'auth', key: '  HUMLE ' });
  await wait(80);
  check(last(a, 'sharegate')?.ok === true, 'koden godtas uansett store bokstaver og mellomrom');
  a.close();
}

console.log('\nOmlastet fane');
{
  const lytter = await open();
  j(lytter, { type: 'hello', id: 'lytter', name: 'Lytter' });
  const gammel = await open();
  j(gammel, { type: 'hello', id: 'fane-1', name: 'Mac · Chrome' });
  j(gammel, { type: 'auth', key: 'humle' });
  await wait(80);
  gammel.send(pakke()); await wait(60);
  check(last(lytter, 'broadcast')?.active === true, 'senderen er aktiv');

  // Samme fane kommer tilbake — den gamle socketen er IKKE lukket.
  const ny = await open();
  await wait(60);
  check(last(ny, 'broadcast')?.active === true, '(ny fane ser forst den gamle strommen)');
  j(ny, { type: 'hello', id: 'fane-1', name: 'Mac · Chrome' });
  await wait(120);
  check(last(lytter, 'broadcast')?.active === false, 'strommen frigjores med en gang, ikke etter taushet');
  check(last(lytter, 'peers')?.count === 2, `ingen spokelser i lista (${last(lytter, 'peers')?.count})`);
  check(gammel.closeCode === 4000 || gammel.readyState !== 1, 'den gamle tilkoblingen kastes');

  // Ny kobling uten sender skal si NEI eksplisitt.
  const sen = await open();
  await wait(60);
  check(last(sen, 'broadcast')?.active === false, 'ny tilkobling faar vite at ingen sender');
  sen.close();

  console.log('\nStyring');
  j(ny, { type: 'auth', key: 'humle' }); await wait(60);
  ny.send(pakke()); await wait(60);
  check(last(lytter, 'broadcast')?.active === true, 'ny sender er i gang');

  // Uten kode: ingenting skjer.
  j(lytter, { type: 'admin', action: 'stop-sharing' }); await wait(60);
  check(last(lytter, 'broadcast')?.active === true, 'lytter uten kode kan ikke stoppe strommen');
  j(lytter, { type: 'admin', action: 'kick', id: 'fane-1' }); await wait(60);
  check(ny.readyState === 1, 'lytter uten kode kan ikke kaste ut noen');

  // Med kode, fra en annen enhet.
  const eier = await open();
  j(eier, { type: 'hello', id: 'eier', name: 'iPhone' });
  j(eier, { type: 'auth', key: 'Humle' }); await wait(60);
  j(eier, { type: 'admin', action: 'stop-sharing' }); await wait(80);
  check(!!last(ny, 'stop-sharing'), 'senderen faar beskjed om aa stoppe');
  check(last(lytter, 'broadcast')?.active === false, 'strommen er stoppet for alle');

  j(eier, { type: 'admin', action: 'kick', id: 'lytter' }); await wait(120);
  check(lytter.closeCode === 4001, `lytteren er kastet ut (kode ${lytter.closeCode})`);
  const p = last(eier, 'peers');
  check(p?.devices?.every(d => d.id !== 'lytter'), 'og er borte fra lista');

  console.log('\nSenderen stopper selv');
  ny.send(pakke()); await wait(60);
  check(last(eier, 'broadcast')?.active === true, 'deler igjen');
  j(ny, { type: 'sharing-stopped' }); await wait(60);
  check(last(eier, 'broadcast')?.active === false, 'stopp gjelder med en gang, ikke etter taushet');

  console.log('\nLyttestatus');
  j(eier, { type: 'state', listening: true }); await wait(60);
  const q = last(ny, 'peers');
  check(q.listening === 1 && q.count === 2, `lyttere telles for seg (${q.listening} av ${q.count})`);
  ny.close(); eier.close();
}

console.log('\nFor mange feil');
{
  const ip = { 'cf-connecting-ip': '203.0.113.9' };
  for (let i = 0; i < 2; i++) {
    const w = await open(ip);
    for (let k = 0; k < 5; k++) j(w, { type: 'auth', key: 'feil' + k });
    await wait(60); w.close();
  }
  const w = await open(ip);
  j(w, { type: 'auth', key: 'humle' }); await wait(60);
  check(last(w, 'sharegate')?.ok === false, 'sperret etter ti feil — selv med riktig kode');
  w.close();
  const annen = await open({ 'cf-connecting-ip': '203.0.113.10' });
  j(annen, { type: 'auth', key: 'humle' }); await wait(60);
  check(last(annen, 'sharegate')?.ok === true, 'andre adresser er ikke rammet');
  annen.close();
}

console.log('\nUgyldig adresse');
{
  const status = await new Promise(r =>
    http.get(`http://127.0.0.1:${PORT}/%E0%A4%A`, res => r(res.statusCode)).on('error', () => r('krasj')));
  check(status === 400, `gir 400, ikke krasj (${status})`);
  await wait(100);
  const w = await open().catch(() => null);
  check(!!w, 'serveren lever fortsatt');
  w?.close();
  const cc = await new Promise(r =>
    http.get(`http://127.0.0.1:${PORT}/stream.js`, res => r(res.headers['cache-control'])));
  check(cc === 'no-cache', 'filer mellomlagres ikke av Cloudflare');
}

console.log(fail ? `\n${fail} FEIL\n` : '\nAlt OK\n');
process.exit(fail ? 1 : 0);
