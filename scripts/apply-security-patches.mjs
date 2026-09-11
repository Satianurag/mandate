#!/usr/bin/env node
/** Reproducible, version-checked guards for an upstream parser without a published fixed release.
 * npm audit still reports the original package/advisories; this does not disguise the version.
 * GHSA-w3rx-r6r6-pgpr and GHSA-5p2g-fcmc-qvqq. See docs/DEPENDENCIES.md.
 */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('..',import.meta.url).pathname;
const directory=`${root}/node_modules/image-size`;
let packageInfo;
try{packageInfo=JSON.parse(await readFile(`${directory}/package.json`,'utf8'));}
catch(error){if(error.code==='ENOENT'){console.log('image-size not installed; no parser patch required');process.exit(0);}throw error;}
if(packageInfo.version!=='1.2.1')throw new Error('Re-review image-size parser patch for the newly resolved version; do not apply it blindly');
const marker='/* Mandate security guard: validate forward progress and buffer bounds. */';
async function patch(file,expected,edit){
 const path=`${directory}/dist/types/${file}.js`,source=await readFile(path,'utf8');
 if(source.includes(marker))return;
 if(createHash('sha256').update(source).digest('hex')!==expected)throw new Error(`Unexpected image-size ${file} source; refuse an unreviewed patch`);
 const result=edit(source);
 if(result===source)throw new Error(`Security patch did not change ${file}`);
 await writeFile(path,`${marker}\n${result}`);
}
await patch('icns','5e6a097fca237b0bb3b68a1be920e39a3846c0018d8917658b5ed88590a710e8',source=>source.replace(
 '    const imageLengthOffset = imageOffset + ENTRY_LENGTH_OFFSET;',
 '    if (!Number.isInteger(imageOffset) || imageOffset < 8 || imageOffset + 8 > input.length) throw new TypeError("Truncated ICNS entry");\n    const imageLengthOffset = imageOffset + ENTRY_LENGTH_OFFSET;\n    const size = (0, utils_1.readUInt32BE)(input, imageLengthOffset);\n    if (size < 8 || size > input.length - imageOffset) throw new TypeError("Invalid ICNS entry length");'
));
await patch('utils','e9faf86abcc962a5fc2488a4c3c9d8dc915aa22a0dd6a7bad6556cd9a326c349',source=>source.replace(
 '    if (input.length - offset < 4)\n        return;\n    const boxSize = (0, exports.readUInt32BE)(input, offset);',
 '    if (!Number.isInteger(offset) || offset < 0 || input.length - offset < 8) return;\n    const declaredSize = (0, exports.readUInt32BE)(input, offset);\n    const boxSize = declaredSize === 0 ? input.length - offset : declaredSize;\n    if (boxSize < 8) throw new TypeError("Invalid image box length");'
));
console.log('Applied/verified bounded image-size 1.2.1 parser guards; upstream advisory labels are retained.');
