const c=require("crypto");
const line=(l,v)=>console.log(l+": "+(typeof v==="string"?v:JSON.stringify(v)));
const key=Buffer.from("00112233445566778899aabbccddeeff","hex"),iv=Buffer.from("0f0e0d0c0b0a09080706050403020100","hex");
// streaming: update returns data as it goes
for (const [name,ivv] of [["aes-128-cbc",iv],["aes-128-ecb",null],["aes-128-ctr",iv],["aes-128-cfb",iv],["aes-128-ofb",iv],["aes-128-gcm",iv.subarray(0,12)]]) {
  const ci=c.createCipheriv(name,key,ivv);
  const parts=[ci.update("hello ")||"", ci.update("world, this is a longer message than one block")];
  const fin=ci.final();
  const tag=name.endsWith("gcm")?ci.getAuthTag():null;
  line(name+" enc",[parts.map(p=>p.length),fin.length,Buffer.concat([...parts,fin]).toString("hex"),tag&&tag.toString("hex")]);
  const de=c.createDecipheriv(name,key,ivv);
  if(tag)de.setAuthTag(tag);
  const dparts=[de.update(Buffer.concat([...parts,fin]).subarray(0,20)),de.update(Buffer.concat([...parts,fin]).subarray(20))];
  const dfin=de.final();
  line(name+" dec",[dparts.map(p=>p.length),dfin.length,Buffer.concat([...dparts,dfin]).toString()]);
}
// des-ede3
for (const name of ["des-ede3-cbc","des-ede3","aes-192-cbc","aes-256-cfb"]) {
  const k=Buffer.alloc(name.includes("des")?24:name.includes("192")?24:32,7);const v=name==="des-ede3"?null:Buffer.alloc(name.includes("des")?8:16,3);
  const ci=c.createCipheriv(name,k,v);const enc=Buffer.concat([ci.update("some plaintext data!!"),ci.final()]);
  line(name,[enc.toString("hex"),Buffer.concat([(d=>d)(c.createDecipheriv(name,k,v).update(enc)),c.createDecipheriv(name,k,v).update(enc).length?Buffer.alloc(0):Buffer.alloc(0)]).length>=0]);
}
// ccm
const ccm=c.createCipheriv("aes-128-ccm",key,iv.subarray(0,12),{authTagLength:16});ccm.setAAD(Buffer.from("aad"),{plaintextLength:5});
const e=Buffer.concat([ccm.update("hello"),ccm.final()]);line("ccm",[e.toString("hex"),ccm.getAuthTag().toString("hex")]);
const dccm=c.createDecipheriv("aes-128-ccm",key,iv.subarray(0,12),{authTagLength:16});dccm.setAAD(Buffer.from("aad"),{plaintextLength:5});dccm.setAuthTag(ccm.getAuthTag());
line("ccm dec",Buffer.concat([dccm.update(e),dccm.final()]).toString());
// wrap
const kek=Buffer.alloc(16,1),wr=c.createCipheriv("id-aes128-wrap",kek,Buffer.from("A6A6A6A6A6A6A6A6","hex"));const w=Buffer.concat([wr.update(Buffer.alloc(16,9)),wr.final()]);line("wrap",w.toString("hex"));
const uw=c.createDecipheriv("id-aes128-wrap",kek,Buffer.from("A6A6A6A6A6A6A6A6","hex"));line("unwrap",Buffer.concat([uw.update(w),uw.final()]).toString("hex"));
// errors
for (const f of [()=>{const d=c.createDecipheriv("aes-128-cbc",key,iv);d.update(Buffer.alloc(16,5));return d.final()},()=>{const d=c.createDecipheriv("aes-128-gcm",key,iv.subarray(0,12));d.setAuthTag(Buffer.alloc(16));d.update(Buffer.alloc(5));return d.final()},()=>{const ci=c.createCipheriv("aes-128-cbc",key,iv);ci.setAutoPadding(false);ci.update("abc");return ci.final()},()=>c.createCipheriv("aes-128-cbc",Buffer.alloc(5),iv),()=>c.createCipheriv("nope",key,iv),()=>c.createCipheriv("aes-128-gcm",key,iv).getAuthTag(),()=>c.createCipheriv("aes-128-ccm",key,iv.subarray(0,12))])
 try{line("err",String(f()))}catch(e){line("err",[e.constructor.name,e.code,e.message])}
line("info",[c.getCipherInfo("aes-128-cbc"),c.getCipherInfo("aes-256-gcm"),c.getCipherInfo("nope")]);
line("ciphers",[c.getCiphers().includes("aes-128-cfb"),c.getCiphers().includes("des-ede3-cbc")]);
const p=c.createCipheriv("aes-128-ctr",key,iv);const {Readable}=require("stream");const chunks=[];
Readable.from([Buffer.from("aaaa"),Buffer.from("bbbb")]).pipe(p).on("data",d=>chunks.push(d)).on("end",()=>line("pipe",[chunks.length,Buffer.concat(chunks).toString("hex")]));
