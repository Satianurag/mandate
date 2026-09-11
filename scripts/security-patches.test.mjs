import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {ICNS}=require('../node_modules/image-size/dist/types/icns.js');
const {findBox}=require('../node_modules/image-size/dist/types/utils.js');
const {imageSize}=require('image-size');
test('ICNS zero-length and truncated entries fail rather than looping',()=>{
 const bytes=Buffer.alloc(24);bytes.write('icns');bytes.writeUInt32BE(24,4);bytes.write('ic07',8);bytes.writeUInt32BE(8,12);bytes.write('ic07',16);
 assert.throws(()=>ICNS.calculate(bytes),/entry length/);
 bytes.writeUInt32BE(8,20);assert.equal(ICNS.calculate(bytes).width,128);
 assert.throws(()=>ICNS.calculate(bytes.subarray(0,18)),/Truncated/);
});
test('zero-length ISO image boxes consume the remaining buffer and cannot be rediscovered forever',()=>{
 const bytes=Buffer.alloc(16);bytes.write('jxlp',4);
 assert.deepEqual(findBox(bytes,'jxlp',0),{name:'jxlp',offset:0,size:16});
 assert.equal(findBox(bytes,'jxlp',16),undefined);
 bytes.writeUInt32BE(1,0);assert.throws(()=>findBox(bytes,'jxlp',0),/box length/);
});
test('public JXL and HEIF detection terminate for malformed zero-sized boxes',()=>{
 execFileSync(process.execPath,['--input-type=module','-e',`
 import {createRequire} from 'node:module';const require=createRequire(import.meta.url);const {imageSize}=require('image-size');
 for(const type of ['JXL ','ftyp']){const b=Buffer.alloc(64);b.write(type,4);b.write('heic',8);try{imageSize(b);}catch{}}
 `],{cwd:new URL('..',import.meta.url),timeout:2000});
});
test('ordinary PNG dimension parsing still works',()=>{
 const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489','hex');
 const size=imageSize(png);assert.equal(size.width,1);assert.equal(size.height,1);
});
