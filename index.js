/**
 * agnes-image — DeepSeek Harness tool for Agnes Image 2.5 Flash.
 *
 * Registers one host tool, `agnes_image`, that calls the Agnes image endpoint
 * (POST {baseURL}/images/generations), saves the result into the Session
 * working directory, stores it in the attachment store (so the conversation
 * shows the image inline), and returns the durable file path to the model.
 *
 * Deliberately dependency-free: it imports only Node builtins and uses the
 * injected Cordis context (`ctx.tools`, `ctx.credentials`, `ctx.attachments`,
 * `ctx.workingDirectory`), so it loads from a profile without a build step or
 * any `@deepseek-ai/*` peer dependency.
 *
 * Docs: https://agnes-ai.com/zh-Hans/docs/agnes-image-25-flash
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpsRequest } from 'node:https'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'agnes-image'

/** The tool registry must exist before `apply` runs. */
export const inject = ['tools']

const DEFAULTS = {
  model: 'agnes-image-2.5-flash',
  baseURL: 'https://apihub.agnes-ai.com/v1',
  apiKeyEnv: 'AGNES_API_KEY',
  outputDir: 'agnes-images',
  timeoutMs: 300_000,
}

const MODELS = ['agnes-image-2.5-flash', 'agnes-image-2.1-flash', 'agnes-image-2.0-flash']
const SIZES = ['1K', '2K', '3K', '4K']
const RATIOS = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']

/** Media types accepted from local reference images. */
const REFERENCE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

const EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

function pad(value) {
  return String(value).padStart(2, '0')
}

/** Local-time stamp used in default file names. */
function timestamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Identify the image format from its magic bytes (the API returns PNG today). */
function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 6 && (bytes.toString('ascii', 0, 6) === 'GIF87a' || bytes.toString('ascii', 0, 6) === 'GIF89a')) return 'image/gif'
  return undefined
}

/** Read width/height from a PNG IHDR header; other formats fall back to the store's metadata. */
function pngDimensions(bytes) {
  if (bytes.length < 24) return undefined
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return undefined
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Restrict model-provided file names to a safe, short base name. */
function safeBaseName(value) {
  return String(value)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64)
}

/** Resolve a workspace-relative path and refuse anything outside the Session directory. */
function insideWorkspace(cwd, candidate) {
  const base = resolve(cwd)
  const target = resolve(base, candidate)
  const rel = relative(base, target)
  if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`output_dir must stay inside the Session working directory (${base})`)
  }
  return target
}

/** Pick a non-existing file path, suffixing -2, -3, ... on collision. */
async function uniqueFilePath(dir, base, extension) {
  let candidate = join(dir, `${base}${extension}`)
  for (let index = 2; index < 1000; index += 1) {
    try {
      await access(candidate)
    } catch {
      return candidate
    }
    candidate = join(dir, `${base}-${index}${extension}`)
  }
  return join(dir, `${base}-${Date.now()}${extension}`)
}

/** Resolve the API key: explicit env wins, then the managed credential store. */
async function resolveApiKey(ctx, ref) {
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const credentials = ctx.get('credentials')
  if (credentials) {
    try {
      const hit = await credentials.resolve(ref)
      if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
    } catch {
      // Fall through to the actionable error below.
    }
  }
  throw new Error(
    `Agnes API key is not configured: set credential ${ref} in ~/.dsh/.credentials.yaml or export ${ref}.`,
  )
}

/** Session working directory, with a process fallback for tests. */
function sessionCwd(ctx, exec) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory && exec.agent) {
    try {
      const cwd = workingDirectory.get(exec.agent.session)
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      // Fall through.
    }
  }
  if (exec.agent && typeof exec.agent.session?.header?.cwd === 'string') return exec.agent.session.header.cwd
  return process.cwd()
}

/** Turn local reference images into data URIs; pass through URLs and data URIs. */
async function resolveReferences(refs, cwd, signal) {
  const output = []
  for (const reference of refs) {
    if (typeof reference !== 'string' || reference.trim().length === 0) continue
    const value = reference.trim()
    if (/^https?:\/\//iu.test(value) || value.startsWith('data:')) {
      output.push(value)
      continue
    }
    signal?.throwIfAborted()
    const declared = REFERENCE_EXTENSIONS[extname(value).toLowerCase()]
    if (declared === undefined) {
      throw new Error(`reference image "${value}" must be a PNG/JPEG/WebP/GIF file, an http(s) URL, or a data: URI`)
    }
    const filePath = resolve(cwd, value)
    let bytes
    try {
      bytes = await readFile(filePath)
    } catch (error) {
      throw new Error(`cannot read reference image "${value}": ${error?.message ?? error}`)
    }
    const mediaType = sniffMediaType(bytes)
    if (mediaType === undefined || mediaType !== declared) {
      throw new Error(`reference image "${value}" does not match its ${declared} extension`)
    }
    output.push(`data:${mediaType};base64,${bytes.toString('base64')}`)
  }
  return output
}

/**
 * Minimal HTTPS JSON transport. The Electron host's global fetch can fail on
 * this network (undici dispatcher/connect behaviour), while node:https reaches
 * the endpoint reliably and reports a concrete error code.
 */
function httpsRequestBuffer(url, { method = 'GET', headers = {}, body, signal, timeoutMs = 300_000, redirects = 3 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(url)
    if (target.protocol !== 'https:') {
      reject(new Error(`unsupported protocol ${target.protocol}`))
      return
    }
    const request = httpsRequest(target, { method, headers, signal, family: 4 }, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location && redirects > 0) {
        response.resume()
        resolvePromise(httpsRequestBuffer(new URL(location, target).toString(), {
          method: 'GET',
          headers,
          signal,
          timeoutMs,
          redirects: redirects - 1,
        }))
        return
      }
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolvePromise({ status, headers: response.headers, body: Buffer.concat(chunks) }))
      response.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`request timed out after ${timeoutMs} ms`)))
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

/** Pull image bytes out of either a base64 or a URL API response item. */
async function responseBytes(items, signal) {
  const images = []
  for (const item of items) {
    if (typeof item?.b64_json === 'string' && item.b64_json.length > 0) {
      images.push(Buffer.from(item.b64_json, 'base64'))
      continue
    }
    if (typeof item?.url === 'string' && item.url.length > 0) {
      let download
      try {
        download = await httpsRequestBuffer(item.url, { signal })
      } catch (error) {
        throw new Error(`failed to download the generated image: ${error?.message ?? error}${error?.code ? ` (${error.code})` : ''}`)
      }
      if (download.status < 200 || download.status >= 300) {
        throw new Error(`failed to download the generated image (HTTP ${download.status})`)
      }
      images.push(download.body)
      continue
    }
    throw new Error('the Agnes response contained neither b64_json nor url')
  }
  return images
}

/**
 * Register the `agnes_image` tool.
 * @param ctx - the plugin context providing tools and the optional services.
 * @param config - profile-supplied overrides for model/baseURL/apiKeyEnv/outputDir.
 */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }

  ctx.tools.register({
    name: 'agnes_image',
    description:
      'Generate or edit an image with Agnes Image 2.5 Flash. Use this whenever the user asks to draw, create, design, illustrate, render, or edit a picture/image/photo/poster/logo. '
      + 'Text-to-image takes a detailed prompt; image editing (img2img) and multi-image composition pass local workspace image paths or public URLs through reference_images. '
      + 'One image per call: call it again for another variation. '
      + 'The result is saved into the workspace (agnes-images/ by default) and attached to the conversation; '
      + 'the tool result names the file path, so tell the user where it is and do not re-read the file with read_image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'Detailed generation or edit instruction. Recommended structure: subject + scene/environment + style + lighting + composition + quality. '
            + 'For editing, state what changes and what must be preserved.',
        },
        size: {
          type: 'string',
          enum: SIZES,
          description: 'Output resolution tier. 1K is fastest; 2K is a good default for detail. Default 1K.',
        },
        ratio: {
          type: 'string',
          enum: RATIOS,
          description: 'Aspect ratio used with the size tier. Default 1:1.',
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional input images for img2img or multi-image composition: workspace-relative/absolute local paths, public https URLs, or data: URIs. '
            + 'Order matters when the prompt refers to "the first image", "the second image", etc.',
        },
        output_dir: {
          type: 'string',
          description: 'Directory for the saved file, relative to the Session working directory. Default agnes-images.',
        },
        filename: {
          type: 'string',
          description: 'Optional base name for the saved file (extension is chosen from the returned format). Default agnes-<timestamp>.',
        },
        model: {
          type: 'string',
          enum: MODELS,
          description: 'Agnes image model. Default agnes-image-2.5-flash (newest, strongest). Only override on request.',
        },
      },
      required: ['prompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string' },
          prompt: { type: 'string' },
          size: { type: 'string' },
          ratio: { type: 'string' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                attachmentId: { type: 'string' },
                attachmentMediaType: { type: 'string' },
                attachmentBytes: { type: 'integer' },
                attachmentWidth: { type: 'integer' },
                attachmentHeight: { type: 'integer' },
                name: { type: 'string' },
              },
              required: ['path', 'mediaType', 'bytes', 'width', 'height'],
            },
          },
        },
        required: ['model', 'prompt', 'size', 'ratio', 'images'],
      },
      render: (_args, value) => {
        const lines = [`Generated ${value.images.length} image(s) with ${value.model} (${value.size} ${value.ratio}).`]
        lines.push(`Prompt: ${value.prompt}`)
        for (const image of value.images) {
          lines.push(`File: ${image.path}`)
          lines.push(`Image: ${image.mediaType}, ${image.width}x${image.height} px, ${image.bytes} bytes`)
          if (typeof image.attachmentMediaType === 'string' && typeof image.attachmentBytes === 'number') {
            if (image.attachmentMediaType !== image.mediaType || image.attachmentBytes !== image.bytes) {
              const w = image.attachmentWidth ?? image.width
              const h = image.attachmentHeight ?? image.height
              lines.push(`Attachment copy (normalized): ${image.attachmentMediaType}, ${w}x${h} px, ${image.attachmentBytes} bytes`)
            }
          }
        }
        lines.push('The image is attached to this tool result and saved in the workspace; use the file path above when telling the user where it is.')
        const blocks = [{ type: 'text', text: lines.join('\n') }]
        for (const image of value.images) {
          if (typeof image.attachmentId === 'string' && image.attachmentId.length > 0) {
            // The block must describe the *stored* attachment: the attachment store verifies
            // mediaType/bytes/width/height against these values on every model request.
            blocks.push({
              type: 'image',
              attachment: {
                attachmentId: image.attachmentId,
                mediaType: image.attachmentMediaType ?? image.mediaType,
                bytes: image.attachmentBytes ?? image.bytes,
                width: image.attachmentWidth ?? image.width,
                height: image.attachmentHeight ?? image.height,
                ...(typeof image.name === 'string' ? { name: image.name } : {}),
              },
            })
          }
        }
        return blocks
      },
      presentationMeta: (_args, value) => ({ path: value.images[0]?.path }),
    },
    timeoutMs: settings.timeoutMs,
    isConcurrencySafe: () => true,
    presentCall(args) {
      const preview = args.prompt.length > 60 ? `${args.prompt.slice(0, 60)}…` : args.prompt
      return { card: 'generic', title: `Generate image: ${preview}` }
    },
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0) throw new Error('prompt must be a non-empty string')
      const size = args.size ?? '1K'
      const ratio = args.ratio ?? '1:1'
      const model = args.model ?? settings.model
      if (!SIZES.includes(size)) throw new Error(`size must be one of ${SIZES.join(', ')}`)
      if (!RATIOS.includes(ratio)) throw new Error(`ratio must be one of ${RATIOS.join(', ')}`)
      if (!MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(', ')}`)

      const key = await resolveApiKey(ctx, settings.apiKeyEnv)
      const cwd = sessionCwd(ctx, exec)
      const outputDir = insideWorkspace(cwd, args.output_dir ?? settings.outputDir)
      const references = await resolveReferences(args.reference_images ?? [], cwd, exec.signal)

      const body = {
        model,
        prompt,
        size,
        ratio,
        ...(references.length > 0
          ? { extra_body: { image: references, response_format: 'b64_json' } }
          : { return_base64: true }),
      }

      const endpoint = `${settings.baseURL.replace(/\/+$/u, '')}/images/generations`
      const requestBody = Buffer.from(JSON.stringify(body), 'utf8')
      let response
      try {
        response = await httpsRequestBuffer(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': requestBody.byteLength,
            Authorization: `Bearer ${key}`,
          },
          body: requestBody,
          signal: exec.signal,
          timeoutMs: settings.timeoutMs,
        })
      } catch (error) {
        throw new Error(`Agnes image request failed: ${error?.message ?? error}${error?.code ? ` (${error.code})` : ''}`)
      }

      const text = response.body.toString('utf8')
      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`Agnes image API returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`)
      }
      if (response.status < 200 || response.status >= 300) {
        const detail = payload?.error?.message ?? payload?.message ?? text.slice(0, 300)
        throw new Error(`Agnes image generation failed (HTTP ${response.status}): ${detail}`)
      }

      const items = Array.isArray(payload?.data) ? payload.data : []
      if (items.length === 0) throw new Error(`Agnes image API returned no images: ${text.slice(0, 300)}`)
      const bytesList = await responseBytes(items, exec.signal)
      exec.signal.throwIfAborted()

      const attachments = ctx.get('attachments')
      const base = safeBaseName(args.filename ?? `agnes-${timestamp()}`) || `agnes-${timestamp()}`
      const images = []

      for (const [index, bytes] of bytesList.entries()) {
        const mediaType = sniffMediaType(bytes) ?? 'image/png'
        const extension = EXTENSIONS[mediaType] ?? '.png'
        const suffix = bytesList.length > 1 ? `-${index + 1}` : ''
        const filePath = await uniqueFilePath(outputDir, `${base}${suffix}`, extension)
        await mkdir(outputDir, { recursive: true })
        await writeFile(filePath, bytes)

        let reference
        if (attachments) {
          try {
            reference = await attachments.saveImage({ data: bytes, mediaType, name: `${base}${suffix}${extension}` })
          } catch (error) {
            // A failed attachment must not lose the file on disk.
            ctx.logger?.('agnes-image')?.warn?.(`could not store the generated image as an attachment: ${error?.message ?? error}`)
          }
        }

        const measured = pngDimensions(bytes)
        // `reference` describes the stored (possibly re-encoded/normalized) attachment, whose
        // mediaType/bytes/dimensions can differ from the generated file on disk.
        const stored = reference
          ? {
              mediaType: typeof reference.mediaType === 'string' ? reference.mediaType : mediaType,
              bytes: typeof reference.bytes === 'number' ? reference.bytes : bytes.byteLength,
              width: reference.width ?? measured?.width ?? 0,
              height: reference.height ?? measured?.height ?? 0,
            }
          : undefined
        images.push({
          path: filePath,
          mediaType,
          bytes: bytes.byteLength,
          width: measured?.width ?? stored?.width ?? 0,
          height: measured?.height ?? stored?.height ?? 0,
          ...(stored
            ? {
                attachmentMediaType: stored.mediaType,
                attachmentBytes: stored.bytes,
                attachmentWidth: stored.width,
                attachmentHeight: stored.height,
              }
            : {}),
          ...(reference?.attachmentId ? { attachmentId: String(reference.attachmentId) } : {}),
          ...(reference?.name ? { name: reference.name } : {}),
        })
      }

      return { model, prompt, size, ratio, images }
    },
  })
}
