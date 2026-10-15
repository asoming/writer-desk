'use strict';
const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {randomBytes}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8');
const start=source.indexOf("ipcMain.handle('writer:print-book-pdf'");
const end=source.indexOf("ipcMain.on('writer:storage'",start);
function setup(directory,overrides={}){
  let callback;const calls=[];
  const window={isDestroyed:()=>false,webContents:{executeJavaScript:async expression=>{calls.push(['prepared',expression]);return true;},printToPDF:async options=>{calls.push(['print',options]);return Buffer.from('%PDF-1.7\ntest fixture');}}};
  const dialog={showSaveDialog:async()=>({filePath:path.join(directory,'书籍.pdf')})};
  const context={ipcMain:{handle:(_name,handler)=>{callback=handler;}},trusted:event=>event.trusted===true,text:(zh)=>zh,pdfBusy:false,closing:false,allowQuit:false,updateBusy:false,window,dialog,app:{getPath:()=>directory},path,fs,randomBytes,Buffer,...overrides};
  vm.runInNewContext(source.slice(start,end),context);
  return{run:(event={trusted:true},options={title:'海边',paper:'a4'})=>callback(event,options),context,calls,window,dialog};
}
test('PDF bridge accepts only a trusted sender and fixed layout options',async()=>{
  const h=setup(os.tmpdir());assert.equal((await h.run({trusted:false})).code,'untrusted-sender');
  for(const options of [null,[],{title:'海边',paper:'a4',path:'/tmp/overwrite'},{title:'海边',paper:'a4',html:'<html>'},{title:'海边',paper:'a3'},{title:'x'.repeat(201),paper:'a4'},{title:'x',paper:'custom'},{title:'x',paper:'custom',pageWidth:99,pageHeight:200},{title:'x',paper:'custom',pageWidth:200,pageHeight:451},{title:'x',paper:'custom',pageWidth:NaN,pageHeight:200},{title:'x',paper:'custom',pageWidth:200,pageHeight:Infinity}])assert.equal((await h.run({trusted:true},options)).code,'pdf-invalid-request');
  assert.deepEqual(h.calls,[]);
});
test('PDF bridge prints prepared current document and writes only a picker-selected destination',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'writer-pdf-test-'));
  try{const h=setup(directory),result=await h.run({trusted:true},{title:'海边 <书>',paper:'a5'});assert.equal(result.saved,true);assert.ok(fs.readFileSync(path.join(directory,'书籍.pdf'),'utf8').startsWith('%PDF-'));assert.equal(fs.readdirSync(directory).length,1);assert.equal(h.calls[1][1].pageSize,'A5');assert.equal(h.calls[1][1].preferCSSPageSize,true);assert.ok(!h.calls[0][1].includes('海边'));}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('PDF cancel, missing preparation and invalid output leave no exports',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'writer-pdf-cancel-'));
  try{
    const canceled=setup(directory);canceled.dialog.showSaveDialog=async()=>({canceled:true});assert.equal((await canceled.run()).canceled,true);assert.equal(canceled.calls.length,1);
    const missing=setup(directory);missing.window.webContents.executeJavaScript=async()=>false;missing.dialog.showSaveDialog=async()=>assert.fail('Unprepared document must not reach the picker');assert.equal((await missing.run()).code,'pdf-export-failed');
    const invalid=setup(directory);invalid.window.webContents.printToPDF=async()=>Buffer.from('not PDF');assert.equal((await invalid.run()).code,'pdf-export-failed');assert.deepEqual(fs.readdirSync(directory),[]);
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('PDF concurrent and app-closing operations do not race the native picker',async()=>{
  const h=setup(os.tmpdir());let release;h.dialog.showSaveDialog=()=>new Promise(resolve=>{release=resolve;});const first=h.run();await new Promise(resolve=>setImmediate(resolve));assert.equal((await h.run()).code,'pdf-busy');release({canceled:true});assert.equal((await first).canceled,true);h.context.closing=true;assert.equal((await h.run()).code,'pdf-busy');
});

test('PDF bridge supports Letter and bounded custom paper with CSS page margins preserved',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'writer-pdf-layout-'));
  try{const letter=setup(directory);assert.equal((await letter.run({trusted:true},{title:'Letter',paper:'letter'})).saved,true);assert.equal(letter.calls[1][1].pageSize,'Letter');const custom=setup(directory);assert.equal((await custom.run({trusted:true},{title:'Custom',paper:'custom',pageWidth:180,pageHeight:250})).saved,true);assert.deepEqual(JSON.parse(JSON.stringify(custom.calls[1][1].pageSize)),{width:180/25.4,height:250/25.4});assert.equal(custom.calls[1][1].preferCSSPageSize,true);}finally{fs.rmSync(directory,{recursive:true,force:true});}
});
