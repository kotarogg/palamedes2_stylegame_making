import { describe, it, expect } from 'vitest';
import { TouchController } from '../src/mobile/touchController';

describe('mobile touch commands', () => {
 it('retains a fast movement tap that ends before the next tick', () => {
  const t = new TouchController(); t.press(1,'left'); t.release(1);
  expect(t.poll().filter(c=>c.type==='left')).toHaveLength(1);
 });
 it('supports two fingers, single fire and movement repeat at 250/100ms', () => {
  let now=0; const t=new TouchController(()=>now);
  t.press(1,'right'); t.press(2,'launch');
  expect(t.poll().map(c=>c.type)).toEqual(['cancelRepeat','right','launch']);
  now=249; expect(t.poll()).toEqual([]);
  now=250; expect(t.poll()).toEqual([{player:0,type:'right',repeat:true}]);
  now=350; expect(t.poll()).toHaveLength(1);
  t.release(1); t.poll(); now=1000; expect(t.poll()).toEqual([]);
 });
 it('opposing directions are neutral; releasing one resumes the other', () => {
  const t=new TouchController();t.press(1,'left');t.press(2,'right');
  expect(t.poll().every(c=>c.type==='cancelRepeat')).toBe(true);
  t.release(2);expect(t.poll().map(c=>c.type)).toEqual(['cancelRepeat','left']);
 });
 it('reset drops pending commands and quarantines held pointers', () => {
  const t=new TouchController();t.press(1,'launch');t.reset();t.press(1,'launch');
  expect(t.poll()).toEqual([]);t.release(1);t.press(1,'launch');expect(t.poll()).toHaveLength(1);
 });
 it('does not repeat fire or deliver input to an earlier catch-up tick', () => {
  const t=new TouchController();t.press(1,'launch');t.press(1,'launch');
  expect(t.poll(undefined,{at:0,last:false})).toEqual([]);
  expect(t.poll(undefined,{at:16,last:true})).toEqual([{player:0,type:'launch'}]);
  expect(t.poll()).toEqual([]);
 });
});

import { FlickGesture } from '../src/mobile/gesture';
import { MOBILE_PREFERENCES_KEY, readMovementMode, writeMovementMode } from '../src/mobile/preferences';

describe('mobile flick input', () => {
 it('does nothing on tap/jitter and starts movement before release at the threshold', () => {
  const t=new TouchController();const g=new FlickGesture(t);
  g.start(1,50,50);expect(g.move(1,60,50)).toBeNull();expect(t.poll()).toEqual([]);
  expect(g.move(1,64,50)).toBe('right');expect(t.poll().map(c=>c.type)).toEqual(['cancelRepeat','right']);
  g.end(1);expect(t.poll()).toEqual([{player:0,type:'cancelRepeat'}]);
 });
 it('supports hold repeat plus independent right-hand launch and stops on release', () => {
  let now=0;const t=new TouchController(()=>now);const g=new FlickGesture(t);
  g.start(1,100,100);g.move(1,80,100);t.press(2,'launch');t.poll();
  now=250;expect(t.poll()).toEqual([{player:0,type:'left',repeat:true}]);
  g.end(1);t.poll();now=1000;expect(t.poll()).toEqual([]);
 });
 it('raises only once and cannot change a horizontal gesture into a raise', () => {
  const t=new TouchController();const g=new FlickGesture(t);
  g.start(1,0,0);expect(g.move(1,0,-20)).toBe('manualRise');g.move(1,0,-100);
  expect(t.poll()).toEqual([{player:0,type:'manualRise'}]);g.end(1);
  g.start(2,0,0);g.move(2,20,0);t.poll();expect(g.move(2,20,-100)).toBeNull();expect(t.poll()).toEqual([]);
 });
 it('rejects ambiguous diagonals, downward swipes, and a second left-pad finger', () => {
  const t=new TouchController();const g=new FlickGesture(t);
  g.start(1,0,0);expect(g.start(2,0,0)).toBe(false);expect(g.move(2,100,0)).toBeNull();
  expect(g.move(1,20,-20)).toBeNull();expect(g.move(1,0,20)).toBeNull();expect(g.move(1,100,0)).toBeNull();expect(t.poll()).toEqual([]);
 });
 it('disables rise in MODE2 and permits a new gesture after cancellation', () => {
  const t=new TouchController();const g=new FlickGesture(t,false);
  g.start(1,0,0);g.move(1,0,-50);expect(t.poll()).toEqual([]);g.reset();
  expect(g.start(2,0,0)).toBe(true);g.move(2,-30,0);expect(t.poll().some(c=>c.type==='left')).toBe(true);
 });
 it('scene reset quarantines a recognised held gesture until release', () => {
  const t=new TouchController();const g=new FlickGesture(t);
  g.start(1,0,0);g.move(1,30,0);t.reset();g.move(1,50,0);expect(t.poll()).toEqual([]);
  g.end(1);g.start(1,0,0);g.move(1,30,0);expect(t.poll().some(c=>c.type==='right')).toBe(true);
 });
});

describe('mobile movement preferences', () => {
 it('defaults safely and remembers the explicit choice', () => {
  const data=new Map<string,string>();const storage={getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}};
  expect(readMovementMode(storage)).toBe('buttons');expect(writeMovementMode(storage,'flick')).toBe(true);expect(readMovementMode(storage)).toBe('flick');
  data.set(MOBILE_PREFERENCES_KEY,'invalid');expect(readMovementMode(storage)).toBe('buttons');
 });
 it('handles blocked storage without breaking play', () => {
  const storage={getItem:()=>{throw new Error('blocked');},setItem:()=>{throw new Error('blocked');}};
  expect(readMovementMode(storage)).toBe('buttons');expect(writeMovementMode(storage,'flick')).toBe(false);
 });
});
