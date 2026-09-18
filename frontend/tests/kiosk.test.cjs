const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') {
    this.tag = tag;
    this.children = [];
    this.parentElement = null;
    this.style = {};
    this.classList = { toggle() {}, contains() { return false; }, remove() {} };
    this.renders = 0;
    this.open = false;
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.renders++; }
  addEventListener() {}
  querySelector() { return null; }
  get childElementCount() { return this.children.length; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const ids = new Map();
const element = id => {
  if (!ids.has(id)) {
    const node = new Element();
    if (id === 'camFrame') node.parentElement = new Element();
    ids.set(id, node);
  }
  return ids.get(id);
};
let response = { status: 'idle', updated_at: 1 };
let cameraState = 'empty';
let pendingTimeout = null;
const context = vm.createContext({
  document: { getElementById: element, createElement: tag => new Element(tag), addEventListener() {} },
  window: { addEventListener() {} },
  localStorage: { getItem() { return null; }, setItem() {} },
  fetch: async url => ({
    ok: true,
    json: async () => {
      if (url === '/api/camera/status') return { camera_open: true, has_reference: true, state: cameraState, box_status: 'none' };
      if (url === '/api/calibration') return { roi: { x: 0.2, y: 0.15, w: 0.6, h: 0.75 }, presence_on_ratio: 0.12, presence_off_ratio: 0.04 };
      return response;
    },
  }),
  setInterval() {}, setTimeout(fn) { pendingTimeout = fn; return 1; }, clearTimeout() { pendingTimeout = null; }, AbortSignal, Intl, console,
});
vm.runInContext(fs.readFileSync('frontend/static/js/detect-box.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('frontend/static/js/spin-viewer.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('frontend/static/js/price.js', 'utf8'), context);
vm.runInContext(fs.readFileSync('frontend/static/js/kiosk.js', 'utf8'), context);

(async () => {
  // Let startup polling finish before manually advancing server responses.
  await new Promise(resolve => setImmediate(resolve));
  response = { status: 'matched', scan_event_id: 1, updated_at: 2, confidence: 0.9, product: { id: 1, name: 'A' } };
  await context.pollRecognition();
  const pane = element('infoPane');
  const first = pane.renders;
  await context.pollRecognition();
  assert.equal(pane.renders, first, 'unchanged match must not restart the video');
  response = { ...response, scan_event_id: 2, updated_at: 3, product: { id: 2, name: 'B' } };
  await context.pollRecognition();
  assert.equal(pane.renders, first + 1, 'same status with a different product must render');
  assert(pane.children.some(node => node.textContent === 'B'));
  response = { status: 'needs_reference', updated_at: 4, message: 'Capture empty platform' };
  await context.pollRecognition();
  assert(pane.children[0].children.some(node => node.href === '/calibrate'));
  response = { status: 'matched', scan_event_id: 3, updated_at: 5, manually_confirmed: true, product: { id: 2, name: 'B' } };
  await context.pollRecognition();
  assert(pane.children.flatMap(node => node.children).some(node => node.textContent === 'ยืนยันโดยผู้ใช้'));

  // The held-product popup opens on a confident match and closes when the
  // product leaves the frame.
  const popup = element('productPopup');
  response = { status: 'matched', scan_event_id: 9, updated_at: 9, confidence: 0.8, product: { id: 7, name: 'C', story: 'tale', video_url: 'https://v' } };
  await context.pollRecognition();
  assert.equal(popup.open, true, 'popup opens on a confident match');
  assert(element('popupContent').children.length > 0, 'popup has detail content');
  response = { status: 'idle', updated_at: 10 };
  await context.pollRecognition();
  assert.equal(popup.open, false, 'popup closes once the product is put down');

  // Auto-close: the customer keeps standing in front of the camera so the
  // backend stays "matched" — the popup must still time out on its own and
  // not immediately reopen for the same product.
  response = { status: 'matched', scan_event_id: 20, updated_at: 20, confidence: 0.8, product: { id: 8, name: 'D' } };
  await context.pollRecognition();
  assert.equal(popup.open, true, 'popup opens for the held product');
  assert.equal(typeof pendingTimeout, 'function', 'an auto-close timer was armed');
  pendingTimeout();  // fire the timeout
  assert.equal(popup.open, false, 'popup auto-closes after the timeout');
  response = { ...response, updated_at: 21 };  // still matched, same product
  await context.pollRecognition();
  assert.equal(popup.open, false, 'popup does not nag by reopening for the same held product');

  // Customers never see the similarity score.
  response = { status: 'matched', scan_event_id: 30, updated_at: 30, confidence: 0.66, product: { id: 9, name: 'E', category: 'cat' } };
  await context.pollRecognition();
  const shown = pane.children.flatMap(node => [node, ...node.children]).map(node => node.textContent || '');
  assert(!shown.some(text => text.includes('ความคล้าย')), 'similarity percentage is hidden from customers');

  // The hint under the camera follows the actual state.
  const hint = element('camHint');
  cameraState = 'empty';
  response = { status: 'idle', updated_at: 40 };
  await context.pollRecognition();
  await context.pollCameraStatus();
  assert.equal(hint.textContent, 'หยิบสินค้าขึ้นมาให้กล้องเห็นในกรอบ', 'empty platform asks to pick a product up');
  assert.notEqual(hint.style.display, 'none');
  cameraState = 'present';
  response = { status: 'scanning', updated_at: 41 };
  await context.pollRecognition();
  await context.pollCameraStatus();
  assert(hint.textContent.startsWith('กำลังสแกน'), 'shows scanning while a product is being read');
  response = { status: 'matched', scan_event_id: 31, updated_at: 42, product: { id: 9, name: 'E' } };
  await context.pollRecognition();
  assert.equal(hint.style.display, 'none', 'hint is hidden once a product is shown');

  // The step list beside the camera follows the same states.
  const steps = element('guideSteps').children;
  assert.equal(steps.length, 3, 'three how-to steps');
  assert.equal(steps[2].className, 'guide-step active', 'matched -> step 3 is current');
  assert.equal(steps[0].className, 'guide-step done', 'earlier steps are marked done');
  cameraState = 'empty';
  response = { status: 'idle', updated_at: 50 };
  await context.pollRecognition();
  await context.pollCameraStatus();
  assert.equal(steps[0].className, 'guide-step active', 'empty platform -> step 1 is current');
  assert.equal(steps[2].className, 'guide-step', 'later steps are plain');
  cameraState = 'present';
  response = { status: 'scanning', updated_at: 51 };
  await context.pollRecognition();
  await context.pollCameraStatus();
  assert.equal(steps[1].className, 'guide-step active', 'scanning -> step 2 is current');
  assert.equal(steps[0].className, 'guide-step done');

  console.log('PASS: video, product swap, reference link, manual label, popup, hidden similarity, camera hint');
})().catch(error => { console.error(error); process.exitCode = 1; });
