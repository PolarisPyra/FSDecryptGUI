import { ReadableByteSource, byteSourceFromFile } from "./byte-source";

const SECTOR_SIZE = 512;
const DYNAMIC_HEADER_SIZE = 1024;
const MERGE_CHUNK_SIZE = 1024 * 1024;

const VHD_COOKIE = "conectix";
const DYNAMIC_HEADER_COOKIE = "cxsparse";
const VHD_TYPE_FIXED = 2;
const VHD_TYPE_DYNAMIC = 3;
const VHD_TYPE_DIFFERENCING = 4;
const VHD_FOOTER_DATA_OFFSET = 0x10;
const VHD_FOOTER_DISK_TYPE_OFFSET = 0x3c;
const VHD_FOOTER_UNIQUE_ID_OFFSET = 0x44;
const DYNAMIC_BAT_OFFSET_FIELD = 0x10;
const DYNAMIC_MAX_ENTRIES_FIELD = 0x18;
const DYNAMIC_BLOCK_SIZE_FIELD = 0x20;
const DYNAMIC_PARENT_UNIQUE_ID_OFFSET = 0x28;
const BAT_UNUSED = 0xffffffff;

const MBR_SIGNATURE = [0x55, 0xaa];
const MBR_PARTITION_TABLE_OFFSET = 0x1be;
const MBR_PARTITION_ENTRY_SIZE = 16;
const MBR_MAX_PARTITIONS = 4;
const NTFS_PARTITION_TYPE = 0x07;
const NTFS_MAGIC = [0xeb, 0x52, 0x90, 0x4e];
const NTFS_PROBE_OFFSETS = [0, 32256, 1048576, 512];

export type LocalOutputSink = {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
};

export type VhdMergeOptions = {
  output?:
    | LocalOutputSink
    | ((filename: string) => Promise<LocalOutputSink | undefined>);
  onProgress?: (progress: number) => void;
  onLog?: (message: string) => void;
};

type FixedLayout = {
  type: "fixed";
};

type SparseLayout = {
  type: "sparse";
  bat: Uint32Array;
  blockSize: number;
  bitmapCache: Map<number, Uint8Array>;
};

type VhdLayout = FixedLayout | SparseLayout;

type VhdLayer = {
  file: ReadableByteSource;
  name: string;
  diskType: number;
  ownId: string;
  parentId?: string;
  virtualSize: number;
  layout: VhdLayout;
};

export type VhdLayerInfo = {
  name: string;
  diskType: "fixed/base" | "dynamic/base" | "differencing/child" | `type ${number}`;
  ownId: string;
  parentId?: string;
};

export type VhdMergeResult = {
  outputFilename: string;
  output?: Blob;
  outputSize: number;
  savedToFile: boolean;
  chain: string[];
  ntfsOffset: number;
};

export type VhdNtfsSource = ReadableByteSource & {
  chain: string[];
  ntfsOffset: number;
};

function readAscii(bytes: Uint8Array) {
  return new TextDecoder("ascii").decode(bytes);
}

function readBeU32(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

function readBeU64(bytes: Uint8Array, offset: number) {
  const high = readBeU32(bytes, offset);
  const low = readBeU32(bytes, offset + 4);
  return high * 0x100000000 + low;
}

function guidHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function toByteSource(file: File | ReadableByteSource): ReadableByteSource {
  if (typeof File !== "undefined" && file instanceof File) {
    return byteSourceFromFile(file);
  }

  return file as ReadableByteSource;
}

async function readFileRange(
  file: ReadableByteSource,
  offset: number,
  length: number,
) {
  return file.read(offset, length);
}

async function readFooter(file: ReadableByteSource) {
  if (file.size < SECTOR_SIZE) {
    throw new Error(`${file.name} is too small to be a VHD`);
  }

  const footer = await readFileRange(
    file,
    file.size - SECTOR_SIZE,
    SECTOR_SIZE,
  );
  if (readAscii(footer.slice(0, 8)) !== VHD_COOKIE) {
    throw new Error(`${file.name} is not a valid VHD`);
  }

  return footer;
}

async function parseSparseLayout(
  file: ReadableByteSource,
  footer: Uint8Array,
): Promise<{ layout: SparseLayout; virtualSize: number }> {
  const headerOffset = readBeU64(footer, VHD_FOOTER_DATA_OFFSET);
  const header = await readFileRange(file, headerOffset, DYNAMIC_HEADER_SIZE);

  if (readAscii(header.slice(0, 8)) !== DYNAMIC_HEADER_COOKIE) {
    throw new Error(`${file.name} has an invalid dynamic VHD header`);
  }

  const batOffset = readBeU64(header, DYNAMIC_BAT_OFFSET_FIELD);
  const maxEntries = readBeU32(header, DYNAMIC_MAX_ENTRIES_FIELD);
  const blockSize = readBeU32(header, DYNAMIC_BLOCK_SIZE_FIELD);
  const rawBat = await readFileRange(file, batOffset, maxEntries * 4);
  const bat = new Uint32Array(maxEntries);

  for (let index = 0; index < maxEntries; index++) {
    bat[index] = readBeU32(rawBat, index * 4);
  }

  return {
    layout: { type: "sparse", bat, blockSize, bitmapCache: new Map() },
    virtualSize: maxEntries * blockSize,
  };
}

async function parseVhd(file: ReadableByteSource): Promise<VhdLayer> {
  const footer = await readFooter(file);
  const diskType = readBeU32(footer, VHD_FOOTER_DISK_TYPE_OFFSET);
  const ownId = guidHex(
    footer.slice(VHD_FOOTER_UNIQUE_ID_OFFSET, VHD_FOOTER_UNIQUE_ID_OFFSET + 16),
  );

  if (diskType === VHD_TYPE_FIXED) {
    return {
      file,
      name: file.name,
      diskType,
      ownId,
      virtualSize: file.size - SECTOR_SIZE,
      layout: { type: "fixed" },
    };
  }

  if (diskType !== VHD_TYPE_DYNAMIC && diskType !== VHD_TYPE_DIFFERENCING) {
    throw new Error(`${file.name} uses unsupported VHD type ${diskType}`);
  }

  const { layout, virtualSize } = await parseSparseLayout(file, footer);
  const parentId =
    diskType === VHD_TYPE_DIFFERENCING
      ? guidHex(
          (
            await readFileRange(
              file,
              readBeU64(footer, VHD_FOOTER_DATA_OFFSET),
              DYNAMIC_HEADER_SIZE,
            )
          ).slice(
            DYNAMIC_PARENT_UNIQUE_ID_OFFSET,
            DYNAMIC_PARENT_UNIQUE_ID_OFFSET + 16,
          ),
        )
      : undefined;

  return {
    file,
    name: file.name,
    diskType,
    ownId,
    parentId,
    virtualSize,
    layout,
  };
}

/** Reads bytes from one VHD layer, returning zeros for unallocated sparse blocks. */
async function readLayer(
  layer: VhdLayer,
  virtualOffset: number,
  target: Uint8Array,
) {
  if (virtualOffset >= layer.virtualSize) {
    return 0;
  }

  const capped = target.subarray(
    0,
    Math.min(target.length, layer.virtualSize - virtualOffset),
  );

  if (layer.layout.type === "fixed") {
    capped.set(await readFileRange(layer.file, virtualOffset, capped.length));
    return capped.length;
  }

  const blockIndex = Math.floor(virtualOffset / layer.layout.blockSize);
  const blockOffset = virtualOffset % layer.layout.blockSize;
  const length = Math.min(capped.length, layer.layout.blockSize - blockOffset);

  if (
    blockIndex >= layer.layout.bat.length ||
    layer.layout.bat[blockIndex] === BAT_UNUSED
  ) {
    capped.subarray(0, length).fill(0);
    return length;
  }

  const fileOffset =
    layer.layout.bat[blockIndex] * SECTOR_SIZE + SECTOR_SIZE + blockOffset;
  capped
    .subarray(0, length)
    .set(await readFileRange(layer.file, fileOffset, length));
  return length;
}

/** Describes how much of the current sparse block is either owned by this child or inherited. */
async function deltaRun(
  layer: VhdLayer,
  virtualOffset: number,
  maxLength: number,
) {
  if (layer.layout.type !== "sparse") {
    return { owned: false, length: maxLength };
  }

  const blockIndex = Math.floor(virtualOffset / layer.layout.blockSize);
  const blockOffset = virtualOffset % layer.layout.blockSize;
  if (
    blockIndex >= layer.layout.bat.length ||
    layer.layout.bat[blockIndex] === BAT_UNUSED
  ) {
    return {
      owned: false,
      length: Math.min(maxLength, layer.layout.blockSize - blockOffset),
    };
  }

  let bitmap = layer.layout.bitmapCache.get(blockIndex);
  const blockFileOffset = layer.layout.bat[blockIndex] * SECTOR_SIZE;
  if (!bitmap) {
    bitmap = await readFileRange(layer.file, blockFileOffset, SECTOR_SIZE);
    layer.layout.bitmapCache.set(blockIndex, bitmap);
  }

  const sectorInBlock = Math.floor(blockOffset / SECTOR_SIZE);
  const firstOwned = isBitmapSectorOwned(bitmap, sectorInBlock);
  const maxSectors = Math.ceil(
    Math.min(maxLength, layer.layout.blockSize - blockOffset) / SECTOR_SIZE,
  );
  let sectors = 1;

  while (
    sectors < maxSectors &&
    (sectorInBlock + sectors) * SECTOR_SIZE < layer.layout.blockSize &&
    isBitmapSectorOwned(bitmap, sectorInBlock + sectors) === firstOwned
  ) {
    sectors += 1;
  }

  const runEnd = (sectorInBlock + sectors) * SECTOR_SIZE;
  const length = Math.min(maxLength, runEnd - blockOffset);

  return { owned: firstOwned, length };
}

function isBitmapSectorOwned(bitmap: Uint8Array, sectorInBlock: number) {
  const bitmapByte = bitmap[Math.floor(sectorInBlock / 8)];
  const bitmapBit = 7 - (sectorInBlock % 8);
  return ((bitmapByte >> bitmapBit) & 1) !== 0;
}

/** Reads a range that is known to be owned by a differencing layer. */
async function readDeltaRun(
  layer: VhdLayer,
  virtualOffset: number,
  target: Uint8Array,
) {
  if (layer.layout.type !== "sparse") {
    throw new Error("Cannot read a fixed VHD as a differencing layer");
  }

  const blockIndex = Math.floor(virtualOffset / layer.layout.blockSize);
  const blockOffset = virtualOffset % layer.layout.blockSize;
  const length = Math.min(target.length, layer.layout.blockSize - blockOffset);
  const blockFileOffset = layer.layout.bat[blockIndex] * SECTOR_SIZE;
  const fileOffset = blockFileOffset + SECTOR_SIZE + blockOffset;
  target
    .subarray(0, length)
    .set(await readFileRange(layer.file, fileOffset, length));
  return length;
}

/** Resolves a virtual read by walking child layers from newest to oldest, then falling back to the base. */
async function readChain(
  layers: VhdLayer[],
  virtualSize: number,
  virtualOffset: number,
  target: Uint8Array,
) {
  if (virtualOffset >= virtualSize) {
    return 0;
  }

  const capped = target.subarray(
    0,
    Math.min(target.length, virtualSize - virtualOffset),
  );
  let runLength = capped.length;

  for (let index = layers.length - 1; index >= 1; index--) {
    const run = await deltaRun(layers[index], virtualOffset, runLength);
    runLength = Math.min(runLength, run.length);
    if (run.owned) {
      return readDeltaRun(
        layers[index],
        virtualOffset,
        capped.subarray(0, runLength),
      );
    }
  }

  return readLayer(layers[0], virtualOffset, capped.subarray(0, runLength));
}

async function readChainExact(
  layers: VhdLayer[],
  virtualSize: number,
  virtualOffset: number,
  length: number,
) {
  const output = new Uint8Array(length);
  let read = 0;

  while (read < length) {
    const count = await readChain(
      layers,
      virtualSize,
      virtualOffset + read,
      output.subarray(read),
    );
    if (count === 0) {
      break;
    }
    read += count;
  }

  return output;
}

function hasBytes(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

async function findNtfsOffset(layers: VhdLayer[], virtualSize: number) {
  if (virtualSize >= SECTOR_SIZE) {
    const mbr = await readChainExact(layers, virtualSize, 0, SECTOR_SIZE);

    if (hasBytes(mbr, 510, MBR_SIGNATURE)) {
      for (let index = 0; index < MBR_MAX_PARTITIONS; index++) {
        const entryOffset =
          MBR_PARTITION_TABLE_OFFSET + index * MBR_PARTITION_ENTRY_SIZE;
        if (mbr[entryOffset + 4] === NTFS_PARTITION_TYPE) {
          const lba =
            (mbr[entryOffset + 8] |
              (mbr[entryOffset + 9] << 8) |
              (mbr[entryOffset + 10] << 16) |
              (mbr[entryOffset + 11] << 24)) >>>
            0;
          const offset = lba * SECTOR_SIZE;
          const magic = await readChainExact(layers, virtualSize, offset, 4);
          if (hasBytes(magic, 0, NTFS_MAGIC)) {
            return offset;
          }
        }
      }
    }
  }

  for (const offset of NTFS_PROBE_OFFSETS) {
    if (offset + 4 <= virtualSize) {
      const magic = await readChainExact(layers, virtualSize, offset, 4);
      if (hasBytes(magic, 0, NTFS_MAGIC)) {
        return offset;
      }
    }
  }

  throw new Error("No NTFS partition found in VHD chain");
}

function describeVhdLayer(layer: VhdLayer) {
  const type = vhdLayerType(layer.diskType);
  const parent = layer.parentId ? `, parent=${layer.parentId}` : "";
  return `${layer.name} (${type}, id=${layer.ownId}${parent})`;
}

function vhdLayerType(diskType: number): VhdLayerInfo["diskType"] {
  return diskType === VHD_TYPE_FIXED
    ? "fixed/base"
    : diskType === VHD_TYPE_DYNAMIC
      ? "dynamic/base"
      : diskType === VHD_TYPE_DIFFERENCING
        ? "differencing/child"
        : `type ${diskType}`;
}

export async function inspectVhdLayers(files: Array<File | ReadableByteSource>): Promise<VhdLayerInfo[]> {
  const sources = files.map(toByteSource);
  const layers = await Promise.all(sources.map((file) => parseVhd(file)));
  return layers.map((layer) => ({
    name: layer.name,
    diskType: vhdLayerType(layer.diskType),
    ownId: layer.ownId,
    parentId: layer.parentId,
  }));
}

/** Orders selected VHD layers into one parent-child chain and reports any missing links. */
function buildChain(layers: VhdLayer[]) {
  if (layers.length === 0) {
    throw new Error("Choose at least one APP or VHD chain layer");
  }

  const bases = layers.filter(
    (layer) => layer.diskType !== VHD_TYPE_DIFFERENCING,
  );
  if (bases.length === 0) {
    const children = layers.map(describeVhdLayer).join("; ");
    throw new Error(
      `VHD chain is missing its parent/base layer. You selected only differencing child layer(s): ${children}. ` +
        "Select the matching *_0 APP/OS container or base .vhd together with this OPTION/update layer.",
    );
  }

  if (bases.length > 1) {
    throw new Error(
      `VHD chain has multiple base layers: ${bases.map((layer) => layer.name).join(", ")}. ` +
        "Select only one base APP/OS container or one base .vhd, then its child OPTION/update layers.",
    );
  }

  const base = bases[0];
  const remaining = layers.filter((layer) => layer !== base);
  const chain = [base];
  let lastId = base.ownId;

  while (remaining.length > 0) {
    const nextIndex = remaining.findIndex((layer) => layer.parentId === lastId);
    if (nextIndex === -1) {
      break;
    }

    const [next] = remaining.splice(nextIndex, 1);
    chain.push(next);
    lastId = next.ownId;
  }

  if (remaining.length > 0) {
    const unlinked = remaining.map(describeVhdLayer).join("; ");
    const linked = chain.map((layer) => layer.name).join(" -> ");
    throw new Error(
      `Could not link ${remaining.length} VHD chain layer(s) into the parent-child chain. ` +
        `Linked chain: ${linked}. Unlinked layer(s): ${unlinked}. ` +
        "Make sure you selected every intermediate APP/OPTION VHD layer in order, starting with the *_0 base.",
    );
  }

  return chain;
}

function outputName(topLayer: VhdLayer) {
  return topLayer.name.replace(/\.[^.]+$/, "") + ".merged.ntfs";
}

function yieldToUi() {
  return new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, 0);
  });
}

/** Exports the resolved VHD chain as a flat NTFS image. */
export async function mergeVhdChain(
  files: Array<File | ReadableByteSource>,
  optionsOrProgress?: VhdMergeOptions | ((progress: number) => void),
): Promise<VhdMergeResult> {
  const options =
    typeof optionsOrProgress === "function"
      ? { onProgress: optionsOrProgress }
      : (optionsOrProgress ?? {});
  const { output, onProgress, onLog } = options;
  const ntfsSource = await openVhdChainNtfsSource(files, { onLog });
  const outputSink =
    typeof output === "function" ? await output(ntfsSource.name) : output;
  const chunks: Uint8Array[] = [];
  let written = 0;

  while (written < ntfsSource.size) {
    const chunk = await ntfsSource.read(
      written,
      Math.min(MERGE_CHUNK_SIZE, ntfsSource.size - written),
    );
    if (outputSink) {
      await outputSink.write(chunk);
    } else {
      chunks.push(chunk);
    }
    written += chunk.length;
    onProgress?.(written / ntfsSource.size);
    await yieldToUi();
  }

  if (outputSink) {
    onLog?.("Finalizing local file");
    await outputSink.close();
  }
  onLog?.("Done");

  return {
    outputFilename: ntfsSource.name,
    output: outputSink
      ? undefined
      : new Blob(
          chunks.map(
            (chunk) =>
              chunk.buffer.slice(
                chunk.byteOffset,
                chunk.byteOffset + chunk.byteLength,
              ) as ArrayBuffer,
          ),
          { type: "application/octet-stream" },
        ),
    outputSize: ntfsSource.size,
    savedToFile: Boolean(outputSink),
    chain: ntfsSource.chain,
    ntfsOffset: ntfsSource.ntfsOffset,
  };
}

/** Opens a linked VHD chain as a random-access NTFS source rooted at the detected NTFS partition. */
export async function openVhdChainNtfsSource(
  files: Array<File | ReadableByteSource>,
  options: { onLog?: (message: string) => void } = {},
): Promise<VhdNtfsSource> {
  if (files.length === 0) {
    throw new Error("Choose at least one APP or VHD Chain layer");
  }

  const { onLog } = options;
  const sources = files.map(toByteSource);

  onLog?.(`Parsing ${sources.length} VHD chain layer(s)`);
  const layers = await Promise.all(sources.map((file) => parseVhd(file)));
  for (const layer of layers) {
    onLog?.(`Parsed ${describeVhdLayer(layer)}`);
  }
  const chain = buildChain(layers);
  onLog?.(`Linked chain: ${chain.map((layer) => layer.name).join(" -> ")}`);
  const virtualSize = chain[0].virtualSize;
  const ntfsOffset = await findNtfsOffset(chain, virtualSize);
  const outputSize = virtualSize - ntfsOffset;
  const filename = outputName(chain[chain.length - 1]);
  onLog?.(
    `NTFS starts at ${ntfsOffset.toLocaleString()} bytes, output size ${outputSize.toLocaleString()} bytes`,
  );

  return {
    name: filename,
    size: outputSize,
    chain: chain.map((layer) => layer.name),
    ntfsOffset,
    read: (offset, length) =>
      readChainExact(
        chain,
        virtualSize,
        ntfsOffset + offset,
        Math.min(length, outputSize - offset),
      ),
  };
}
