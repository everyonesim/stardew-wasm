// The game archives are far too big for GitHub Pages to publish (a 600 MB site
// blows past the deploy timeout), so they live on the `game-assets` branch and
// are streamed from raw.githubusercontent.com, which serves them with CORS and
// range support. Append ?assets=local to load them relative to this page when
// you have the .tar chunks next to it (local checkout / file:// copy).
const ASSET_CDN = "https://raw.githubusercontent.com/mywebsitekeepsgettingblocked/stardew-wasm/game-assets/";
const useLocalAssets = location.protocol === "file:" ||
	new URLSearchParams(location.search).get("assets") === "local";
const ASSET_BASE = useLocalAssets ? "" : ASSET_CDN;

const MB = 1048576;
const CHUNK_PARALLELISM = 4;
const FETCH_ATTEMPTS = 4;

const loading = document.getElementById("loading");
const canvas = document.getElementById("canvas");
const musicChoice = document.getElementById("music-choice");
const statusBox = document.getElementById("status");
const statusText = document.getElementById("status-text");
const statusDetail = document.getElementById("status-detail");
const barFill = document.getElementById("bar-fill");
const errorBox = document.getElementById("error");

let started = false;
const abort = new AbortController();

// --- UI ---
function formatBytes(bytes) {
	if (!bytes) return "0 MB";
	if (bytes >= 1024 * MB) return `${(bytes / 1024 / MB).toFixed(2)} GB`;
	return `${Math.round(bytes / MB)} MB`;
}

function setStatus(text, fraction, detail = "") {
	musicChoice.hidden = true;
	errorBox.hidden = true;
	statusBox.hidden = false;
	if (statusText.textContent !== text) statusText.textContent = text;
	statusDetail.textContent = detail;
	if (typeof fraction === "number" && Number.isFinite(fraction)) {
		barFill.classList.remove("indeterminate");
		barFill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
	} else {
		barFill.classList.add("indeterminate");
	}
}

function describeError(error) {
	if (!error) return "Unknown error.";
	const name = error.name && error.name !== "Error" ? `${error.name}: ` : "";
	return `${name}${error.message || String(error)}`;
}

function showError(title, error) {
	statusBox.hidden = true;
	musicChoice.hidden = true;
	errorBox.hidden = false;
	errorBox.replaceChildren();
	const heading = document.createElement("div");
	heading.className = "error-title";
	heading.textContent = title;
	const detail = document.createElement("div");
	detail.className = "error-detail";
	detail.textContent = describeError(error);
	const retry = document.createElement("button");
	retry.type = "button";
	retry.textContent = "Reload";
	retry.addEventListener("click", () => location.reload());
	errorBox.append(heading, detail, retry);
}

window.addEventListener("unhandledrejection", (event) => {
	if (started) { console.error(event.reason); return; }
	showError("The game failed to load", event.reason);
});
window.addEventListener("error", (event) => {
	if (started) { console.error(event.error ?? event.message); return; }
	showError("The game failed to load", event.error ?? event.message);
});

// --- OPFS helpers ---
// The origin private file system needs a secure context and isn't available in
// every browser mode (private windows, some embedded webviews). Saves simply
// won't persist when it's missing, but the game itself still has to boot.
let opfs = null;
try {
	opfs = await navigator.storage.getDirectory();
	// Ask the browser not to evict the cached content or save archive under storage
	// pressure. Browsers may decline, so this is deliberately best-effort.
	void navigator.storage.persist?.().catch(() => false);
} catch (error) {
	console.warn("Origin private file system unavailable; the game content won't be cached between visits.", error);
}

const memoryFiles = new Map();

async function opfsHas(name) {
	if (!opfs) return memoryFiles.has(name);
	try { await opfs.getFileHandle(name); return true; } catch { return false; }
}
async function opfsRead(name) {
	if (!opfs) {
		const cached = memoryFiles.get(name);
		if (cached) return cached;
		throw new DOMException(`No cached ${name}`, "NotFoundError");
	}
	return new Uint8Array(await (await (await opfs.getFileHandle(name)).getFile()).arrayBuffer());
}

// --- Network helpers ---
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithRetry(url, { attempts = FETCH_ATTEMPTS, signal = abort.signal } = {}) {
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(url, { signal });
			if (response.ok) return response;
			// Transient upstream failures (Pages hiccups, rate limits) are worth retrying.
			if (response.status < 500 && response.status !== 429)
				throw new Error(`HTTP ${response.status} for ${url}`);
			lastError = new Error(`HTTP ${response.status} for ${url}`);
		} catch (error) {
			if (signal.aborted) throw error;
			lastError = error;
		}
		if (attempt < attempts) await sleep(400 * attempt);
	}
	throw lastError ?? new Error(`Failed to fetch ${url}`);
}

async function fetchChunkCount(url) {
	const response = await fetchWithRetry(url);
	const text = (await response.text()).trim();
	if (!/^\d+$/.test(text) || Number(text) < 1)
		throw new Error(`Invalid chunk count in ${url}: ${JSON.stringify(text)}`);
	return Number(text);
}

function chunkUrl(base, index) {
	return `${base}${String(index).padStart(2, "0")}`;
}

// Exact byte total, so the progress bar means something. The last chunk is
// usually short, so its size can't be derived from the others.
async function estimateTotalBytes(base, count) {
	const headSize = async (index) => {
		try {
			const response = await fetch(chunkUrl(base, index), { method: "HEAD", signal: abort.signal });
			if (!response.ok) return 0;
			return Number(response.headers.get("content-length")) || 0;
		} catch { return 0; }
	};
	const first = await headSize(0);
	if (!first) return 0;
	if (count === 1) return first;
	const last = await headSize(count - 1);
	return last ? first * (count - 1) + last : first * count;
}

// --- Chunked tar download ---
// Chunks are fetched several at a time (a 540 MB archive over GitHub Pages is
// painfully slow one-by-one) but streamed into `writeChunk` strictly in order.
async function readTarChunks(base, label, writeChunk) {
	const count = await fetchChunkCount(base + ".count");
	const estimateP = estimateTotalBytes(base, count).catch(() => 0);

	const pending = new Map();
	let nextToStart = 0;
	const startFetch = (index) => {
		if (index >= count || pending.has(index)) return;
		const promise = fetchWithRetry(chunkUrl(base, index));
		promise.catch(() => {}); // surfaced when awaited below
		pending.set(index, promise);
	};

	let total = 0;
	let estimate = 0;
	const report = () => {
		const fraction = estimate ? Math.min(1, total / estimate) : null;
		setStatus(`Downloading ${label}`, fraction,
			`${formatBytes(total)}${estimate ? ` of ${formatBytes(estimate)}` : ""}`);
	};

	for (let index = 0; index < CHUNK_PARALLELISM && index < count; index++) startFetch(index);
	nextToStart = Math.min(CHUNK_PARALLELISM, count);

	for (let index = 0; index < count; index++) {
		// Keep the pipeline full: as soon as one chunk is consumed, queue another.
		while (nextToStart < count && pending.size < CHUNK_PARALLELISM) startFetch(nextToStart++);
		const response = await pending.get(index);
		pending.delete(index);
		if (!response.body) throw new Error(`Streaming response body unavailable for ${response.url}`);
		estimate = estimate || (await estimateP);
		report();
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await writeChunk(value);
			total += value.length;
			report();
		}
	}
	return total;
}

async function downloadTarToMemory(base, label) {
	const chunks = [];
	const total = await readTarChunks(base, label, (chunk) => { chunks.push(chunk); });
	const tar = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) { tar.set(c, off); off += c.length; }
	return tar;
}

async function downloadAndCacheTar(base, label, key) {
	if (!opfs) return downloadTarToMemory(base, label);
	let writer;
	try {
		writer = await (await opfs.getFileHandle(key, { create: true })).createWritable();
		await readTarChunks(base, label, (chunk) => writer.write(chunk));
		setStatus(`Saving ${label}`, null);
		await writer.close();
		return await opfsRead(key);
	} catch (error) {
		try { await writer?.abort(); } catch {}
		// A failed OPFS write can leave a newly-created zero-byte handle. Never let
		// that masquerade as a valid cached archive on the next launch.
		try { await opfs.removeEntry(key); } catch {}
		if (error?.name === "AbortError") throw error;
		console.warn(`Couldn't cache ${label} in the origin private file system; keeping it in memory instead.`, error);
		return await downloadTarToMemory(base, label);
	}
}

async function getTar(base, label, key) {
	try {
		setStatus(`Loading cached ${label}`, null);
		return await opfsRead(key);
	} catch {
		return await downloadAndCacheTar(base, label, key);
	}
}

// --- Music choice (skip if audio already cached) ---
const audioCached = await opfsHas("ContentAudio.tar");
const wantMusic = audioCached || await new Promise((resolve) => {
	musicChoice.hidden = false;
	document.getElementById("btn-no-music").onclick = () => { musicChoice.hidden = true; resolve(false); };
	document.getElementById("btn-with-music").onclick = () => { musicChoice.hidden = true; resolve(true); };
});
musicChoice.hidden = true;

// --- Parallel: download tars + boot runtime ---
const contentP = getTar(ASSET_BASE + "Content.tar", "game content", "Content.tar");
const audioP = wantMusic ? getTar(ASSET_BASE + "ContentAudio.tar", "music", "ContentAudio.tar") : Promise.resolve(null);
const runtimeP = (async () => {
	// A readable message instead of a bare "failed to fetch dynamically imported
	// module". The _framework folder is the usual casualty: GitHub Pages runs
	// Jekyll unless a .nojekyll file sits next to this one, and Jekyll drops every
	// folder whose name starts with an underscore.
	let mod;
	try {
		mod = await import("./_framework/dotnet.js");
	} catch (error) {
		throw new Error(
			"Couldn't load _framework/dotnet.js. If this site is on GitHub Pages, " +
			"make sure a .nojekyll file is published so the _framework folder isn't " +
			`stripped by Jekyll. (${describeError(error)})`
		);
	}
	const { dotnet } = mod;
	return dotnet
		.withModuleConfig({ canvas })
		.withEnvironmentVariable("MONO_SLEEP_ABORT_LIMIT", "99999")
		.withRuntimeOptions([
			`--jiterpreter-minimum-trace-hit-count=${500}`,
			`--jiterpreter-trace-monitoring-period=${100}`,
			`--jiterpreter-trace-monitoring-max-average-penalty=${150}`,
			`--jiterpreter-wasm-bytes-limit=${64 * 1024 * 1024}`,
			`--jiterpreter-table-size=${32 * 1024}`,
		])
		.withResourceLoader((type, _name, defaultUri, _integrity, behavior) => {
			if (type === "dotnetwasm" && behavior === "dotnetwasm") {
				return (async () => {
					const count = await fetchChunkCount(defaultUri + ".count");
					let idx = 0;
					const fetchNext = async () => {
						if (idx >= count) return null;
						const uri = defaultUri + idx;
						const res = await fetch(uri);
						idx++;
						if (!res.ok) throw new Error(`Failed to fetch ${uri}: HTTP ${res.status}`);
						if (!res.body) throw new Error(`Streaming response body unavailable for ${uri}`);
						return res.body.getReader();
					};
					let current = await fetchNext();
					if (!current) throw new Error("failed to fetch first wasm chunk");
					return new Response(new ReadableStream({
						async pull(controller) {
							const { value, done } = await current.read();
							if (done || !value) {
								current = await fetchNext();
								if (current) await this.pull(controller);
								else controller.close();
							} else controller.enqueue(value);
						},
					}), { headers: { "Content-Type": "application/wasm" } });
				})();
			}
		})
		.create();
})();

let contentTar, audioTar, runtime;
try {
	setStatus("Downloading game files", null);
	[contentTar, audioTar, runtime] = await Promise.all([contentP, audioP, runtimeP]);
} catch (error) {
	abort.abort(); // stop any downloads that are still running for nothing
	throw error;
}

const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);

// --- Validate and extract tar into WasmFS ---
// Validation is deliberately a separate first pass: a truncated/partial OPFS
// archive must never write half a farm before the parser notices corruption.
function parseTar(tar) {
	if (!(tar instanceof Uint8Array)) throw new TypeError("Tar archive isn't a Uint8Array");
	const entries = [];
	const paths = new Set();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const readString = (buf, offset, length) => {
		let end = offset;
		while (end < offset + length && buf[end] !== 0) end++;
		return decoder.decode(buf.subarray(offset, end));
	};
	const readOctal = (buf, offset, length, field) => {
		const value = readString(buf, offset, length).trim();
		if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${field}: ${JSON.stringify(value)}`);
		const parsed = Number.parseInt(value, 8);
		if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Tar ${field} is out of range`);
		return parsed;
	};
	let pos = 0;
	let foundEnd = false;
	while (pos + 512 <= tar.length) {
		const header = tar.subarray(pos, pos + 512);
		if (header.every((value) => value === 0)) {
			foundEnd = true;
			break;
		}

		const storedChecksum = readOctal(header, 148, 8, "checksum");
		let actualChecksum = 0;
		for (let index = 0; index < 512; index++)
			actualChecksum += index >= 148 && index < 156 ? 32 : header[index];
		if (storedChecksum !== actualChecksum)
			throw new Error(`Tar checksum mismatch at byte ${pos}`);

		const name = readString(header, 0, 100);
		const headerPrefix = readString(header, 345, 155);
		const fullName = headerPrefix ? `${headerPrefix}/${name}` : name;
		const size = readOctal(header, 124, 12, "size");
		const type = header[156];
		const isFile = type === 0 || type === 48;
		const isDirectory = type === 53;
		if (!isFile && !isDirectory) throw new Error(`Unsupported tar entry type ${type} for ${fullName}`);
		if (isDirectory && size !== 0) throw new Error(`Tar directory has data: ${fullName}`);
		if (isFile && fullName.endsWith("/")) throw new Error(`Tar file has a directory path: ${fullName}`);

		const path = fullName.endsWith("/") ? fullName.slice(0, -1) : fullName;
		const segments = path.split("/");
		if (!path || path.startsWith("/") || path.includes("\\") ||
			segments.some((segment) => !segment || segment === "." || segment === ".."))
			throw new Error(`Unsafe tar path: ${JSON.stringify(fullName)}`);
		if (paths.has(path)) throw new Error(`Duplicate tar path: ${JSON.stringify(path)}`);
		paths.add(path);

		const dataStart = pos + 512;
		const dataEnd = dataStart + size;
		const next = dataStart + Math.ceil(size / 512) * 512;
		if (!Number.isSafeInteger(next) || dataEnd > tar.length || next > tar.length)
			throw new Error(`Truncated tar entry: ${fullName}`);
		entries.push({ fullName: path, isDirectory, dataStart, dataEnd });
		pos = next;
	}
	if (!foundEnd) throw new Error("Tar archive has no complete end marker");
	for (let index = pos; index < tar.length; index++)
		if (tar[index] !== 0) throw new Error("Tar archive contains data after its end marker");
	return entries;
}

function extractTar(tar, prefix) {
	const entries = parseTar(tar);
	let count = 0;
	for (const entry of entries) {
		// Legacy full-save archives stored top-level device files under this sentinel.
		const target = entry.fullName.startsWith("__prefs__/")
			? "/libsdl/saves/" + entry.fullName.slice("__prefs__/".length)
			: prefix + entry.fullName;
		if (entry.isDirectory) {
			exports.WasmBootstrap.CreateContentDirectory(target);
		} else {
			exports.WasmBootstrap.WriteContentFile(target, tar.subarray(entry.dataStart, entry.dataEnd));
			count++;
		}
	}
	return count;
}

setStatus("Starting the game runtime", null);
await runtime.runMain();
await exports.WasmBootstrap.PreInit();

// Restore saves from OPFS
try {
	const savesTar = await opfsRead("Saves.tar");
	exports.WasmBootstrap.CreateContentDirectory("/libsdl/saves/Saves");
	extractTar(savesTar, "/libsdl/saves/Saves/");
} catch (error) {
	if (error?.name !== "NotFoundError") console.error("Couldn't restore Saves.tar; archive was ignored:", error);
}
// Preferences are also persisted separately from the much larger save archive.
// Overlay them last so a slow/stale archive write can't roll back zoom, UI scale,
// language, audio, or other device settings.
try {
	const preferencesTar = await opfsRead("DevicePreferences.tar");
	extractTar(preferencesTar, "/libsdl/saves/");
} catch (error) {
	if (error?.name !== "NotFoundError") console.error("Couldn't restore DevicePreferences.tar; archive was ignored:", error);
}

setStatus("Loading game files", null);
extractTar(contentTar, "/libsdl/");
if (audioTar) { setStatus("Loading music", null); extractTar(audioTar, "/libsdl/"); }

loading.classList.add("hidden");
started = true;

const dpr = window.devicePixelRatio || 1;
const w = Math.round(canvas.clientWidth * dpr) || 1280;
const h = Math.round(canvas.clientHeight * dpr) || 720;
await exports.WasmBootstrap.Init(w, h);

new ResizeObserver(() => {
	const dpr = window.devicePixelRatio || 1;
	const nw = Math.round(canvas.clientWidth * dpr);
	const nh = Math.round(canvas.clientHeight * dpr);
	if (nw > 0 && nh > 0) try { exports.WasmBootstrap.Resize(nw, nh); } catch {}
}).observe(canvas);

try { void navigator.keyboard?.lock().catch(() => {}); } catch {}
document.addEventListener("keydown", (e) => {
	if (["Space","ArrowUp","ArrowDown","ArrowLeft","ArrowRight","Tab"].includes(e.code))
		e.preventDefault();
});

try {
	await exports.WasmBootstrap.MainLoop();
} catch (error) {
	// Emscripten throws this sentinel to unwind after installing its browser
	// main loop. It isn't a game failure and shouldn't surface as one.
	if (error !== "unwind" && error?.message !== "unwind") throw error;
}
