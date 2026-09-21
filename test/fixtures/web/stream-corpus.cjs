// Stream semantics that programs depend on. The output must be identical under Node.js.
const { Readable, Writable, Transform, PassThrough, Duplex, pipeline, finished } = require("stream");
const { pipeline: pipelineP, finished: finishedP } = require("stream/promises");
const out = [];
const log = (...a) => out.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));

async function main() {
	// readable: flowing, pause/resume, encoding, objectMode
	{
		const r = Readable.from(["a", "b", "c"]);
		const got = [];
		for await (const c of r) got.push(c);
		log("from/asyncIter", got);
	}
	{
		const r = new Readable({ read() {} });
		r.push("he"); r.push("llo"); r.push(null);
		r.setEncoding("utf8");
		let s = "";
		r.on("data", (c) => (s += c));
		await finishedP(r);
		log("encoding", s, r.readableEnded, r.destroyed);
	}
	{
		const r = new Readable({ read() {} });
		r.push(Buffer.from([0xe2, 0x82])); r.push(Buffer.from([0xac])); r.push(null);
		r.setEncoding("utf8");
		const parts = [];
		r.on("data", (c) => parts.push(c));
		await finishedP(r);
		log("split multibyte", parts);
	}
	{
		const r = new Readable({ objectMode: true, read() {} });
		r.push({ a: 1 }); r.push([2]); r.push(null);
		const got = [];
		r.on("data", (c) => got.push(c));
		await finishedP(r);
		log("objectMode", got);
	}
	{
		// paused mode with read()
		const r = new Readable({ read() {} });
		r.push("abcdef"); r.push(null);
		const reads = [];
		r.on("readable", () => { let c; while ((c = r.read(2)) !== null) reads.push(c.toString()); });
		await finishedP(r);
		log("read(n)", reads);
	}
	// writable: backpressure and ordering
	{
		const written = [];
		const w = new Writable({ highWaterMark: 4, write(chunk, enc, cb) { written.push(chunk.toString()); setTimeout(cb, 1); } });
		const returns = [w.write("ab"), w.write("cd"), w.write("ef")];
		let drained = 0;
		w.on("drain", () => drained++);
		w.end("gh");
		await finishedP(w);
		log("backpressure", returns, written, drained, w.writableFinished, w.writableLength);
	}
	{
		const w = new Writable({ write(chunk, enc, cb) { cb(new Error("boom")); } });
		const events = [];
		w.on("error", (e) => events.push("error:" + e.message));
		w.on("close", () => events.push("close"));
		w.write("x");
		await new Promise((r) => setTimeout(r, 20));
		log("write error", events, w.destroyed);
	}
	{
		const w = new Writable({ write(c, e, cb) { cb(); } });
		w.end();
		let err;
		w.on("error", (e) => (err = e.code));
		w.write("late");
		await new Promise((r) => setTimeout(r, 10));
		log("write after end", err);
	}
	{
		const w = new Writable({ writev(chunks, cb) { log("writev", chunks.map((c) => c.chunk.toString())); cb(); } });
		w.cork(); w.write("1"); w.write("2"); w.write("3"); w.uncork(); w.end();
		await finishedP(w);
	}
	// transform
	{
		const t = new Transform({ transform(chunk, enc, cb) { cb(null, chunk.toString().toUpperCase()); }, flush(cb) { cb(null, "!"); } });
		const got = [];
		t.on("data", (c) => got.push(c.toString()));
		t.write("ab"); t.write("cd"); t.end();
		await finishedP(t);
		log("transform", got);
	}
	// pipeline
	{
		const chunks = [];
		await pipelineP(
			Readable.from(["x", "y", "z"]),
			new Transform({ transform(c, e, cb) { cb(null, c + c); } }),
			new Writable({ write(c, e, cb) { chunks.push(c.toString()); cb(); } })
		);
		log("pipeline", chunks);
	}
	{
		const res = [];
		await pipelineP(
			Readable.from(["1", "2", "3"]),
			async function* (source) { for await (const c of source) yield String(Number(c) * 2); },
			async function (source) { for await (const c of source) res.push(c); }
		);
		log("pipeline generators", res);
	}
	{
		let error;
		try {
			await pipelineP(
				Readable.from(["a"]),
				new Transform({ transform(c, e, cb) { cb(new Error("bad")); } }),
				new PassThrough()
			);
		} catch (e) { error = e.message; }
		log("pipeline error", error);
	}
	// pipe with backpressure to a slow writer preserves order and everything
	{
		const src = new Readable({ read() {} });
		const seen = [];
		const dst = new Writable({ highWaterMark: 3, write(c, e, cb) { seen.push(c.toString()); setImmediate(cb); } });
		for (let i = 0; i < 20; i++) src.push(String(i % 10));
		src.push(null);
		src.pipe(dst);
		await finishedP(dst);
		log("pipe backpressure", seen.join(""));
	}
	// destroy
	{
		const r = new Readable({ read() {} });
		const events = [];
		r.on("close", () => events.push("close"));
		r.on("error", (e) => events.push("error:" + e.message));
		r.destroy(new Error("x"));
		await new Promise((res) => setTimeout(res, 10));
		log("destroy", events, r.destroyed, r.errored && r.errored.message);
	}
	// duplex
	{
		const d = new Duplex({ read() { this.push("r"); this.push(null); }, write(c, e, cb) { log("duplex wrote", c.toString()); cb(); } });
		d.end("w");
		let got = "";
		d.on("data", (c) => (got += c));
		await finishedP(d);
		log("duplex", got);
	}
	// legacy inheritance styles
	{
		const util = require("util");
		function Legacy(opts) { Readable.call(this, opts); this.n = 0; }
		util.inherits(Legacy, Readable);
		Legacy.prototype._read = function () { this.push(this.n++ < 3 ? String(this.n) : null); };
		const got = [];
		for await (const c of new Legacy()) got.push(c.toString());
		log("util.inherits Readable", got.join("")); // how chunks group depends on tick scheduling, their content does not
		class Modern extends Transform { _transform(c, e, cb) { cb(null, "<" + c + ">"); } }
		const m = new Modern();
		m.end("q");
		let s = "";
		for await (const c of m) s += c;
		log("class extends Transform", s, m instanceof Transform, m instanceof Writable, m instanceof Readable);
	}
	// finished / eos on a stream that errors
	{
		const r = new Readable({ read() { this.destroy(new Error("nope")); } });
		try { await finishedP(r.resume()); } catch (e) { log("finished error", e.message); }
	}
	console.log(out.join("\n"));
}
main().catch((e) => console.log("FAILED", e && e.stack));
