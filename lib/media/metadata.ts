// Client-side "make this look like it came from an iPhone in the US" pass.
//
// On upload we stamp realistic Apple capture metadata + a random US GPS
// location so the files carry believable EXIF / QuickTime tags:
//   - Images (JPEG): piexifjs writes EXIF (Make=Apple, Model=iPhone 15 Pro,
//     LensModel, Software, DateTime) and GPS IFD (lat/lon in the US).
//   - Videos (MP4): ffmpeg writes QuickTime tags (make/model/software) and the
//     ISO-6709 com.apple.quicktime.location.ISO6709 location string.
//
// PNGs can't hold EXIF, so they're passed through untouched (the uniqueizer
// re-encodes them anyway). Everything runs in the browser before upload.

import { withFfmpeg } from "@/lib/ffmpeg-client"

// A few plausible iPhone models + matching lens strings.
const IPHONES: Array<{ model: string; lens: string; software: string }> = [
  { model: "iPhone 15 Pro", lens: "iPhone 15 Pro back triple camera 6.765mm f/1.78", software: "17.5.1" },
  { model: "iPhone 14 Pro", lens: "iPhone 14 Pro back triple camera 6.86mm f/1.78", software: "17.4.1" },
  { model: "iPhone 13", lens: "iPhone 13 back dual camera 5.1mm f/1.6", software: "16.6" },
  { model: "iPhone 15", lens: "iPhone 15 back dual camera 5.96mm f/1.6", software: "17.5" },
  { model: "iPhone 12 Pro", lens: "iPhone 12 Pro back triple camera 4.2mm f/1.6", software: "16.3.1" },
]

// Rough lat/lon boxes over major US metros (lon is negative = west).
const US_BOXES: Array<{ latMin: number; latMax: number; lonMin: number; lonMax: number }> = [
  { latMin: 40.55, latMax: 40.85, lonMin: -74.05, lonMax: -73.78 }, // NYC
  { latMin: 33.9, latMax: 34.15, lonMin: -118.5, lonMax: -118.2 }, // LA
  { latMin: 41.79, latMax: 41.97, lonMin: -87.74, lonMax: -87.58 }, // Chicago
  { latMin: 25.7, latMax: 25.86, lonMin: -80.3, lonMax: -80.13 }, // Miami
  { latMin: 37.71, latMax: 37.81, lonMin: -122.51, lonMax: -122.39 }, // SF
  { latMin: 30.2, latMax: 30.4, lonMin: -97.85, lonMax: -97.66 }, // Austin
]

function rand(min: number, max: number) {
  return Math.random() * (max - min) + min
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomUsLocation() {
  const box = pick(US_BOXES)
  return { lat: rand(box.latMin, box.latMax), lon: rand(box.lonMin, box.lonMax) }
}

// A capture date within the last ~30 days, formatted as EXIF "YYYY:MM:DD HH:MM:SS".
function recentExifDate() {
  const d = new Date(Date.now() - Math.floor(rand(0, 30 * 24 * 60 * 60 * 1000)))
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// Convert a decimal degree to EXIF rational [deg, min, sec] arrays.
function toDMSRationals(value: number): Array<[number, number]> {
  const abs = Math.abs(value)
  const deg = Math.floor(abs)
  const minFloat = (abs - deg) * 60
  const min = Math.floor(minFloat)
  const sec = Math.round((minFloat - min) * 60 * 100)
  return [
    [deg, 1],
    [min, 1],
    [sec, 100],
  ]
}

function dataUrlToFile(dataUrl: string, name: string, type: string): File {
  const [, b64] = dataUrl.split(",")
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new File([bytes], name, { type })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function injectImageMetadata(file: File): Promise<File> {
  // Only JPEG can carry EXIF via piexif. PNG/others pass through.
  if (!/jpe?g/i.test(file.type)) return file

  const piexif = (await import("piexifjs")).default
  const dataUrl = await fileToDataUrl(file)
  const phone = pick(IPHONES)
  const { lat, lon } = randomUsLocation()
  const date = recentExifDate()

  const zeroth: Record<number, unknown> = {
    [piexif.ImageIFD.Make]: "Apple",
    [piexif.ImageIFD.Model]: phone.model,
    [piexif.ImageIFD.Software]: phone.software,
    [piexif.ImageIFD.DateTime]: date,
  }
  const exif: Record<number, unknown> = {
    [piexif.ExifIFD.DateTimeOriginal]: date,
    [piexif.ExifIFD.DateTimeDigitized]: date,
    [piexif.ExifIFD.LensMake]: "Apple",
    [piexif.ExifIFD.LensModel]: phone.lens,
  }
  const gps: Record<number, unknown> = {
    [piexif.GPSIFD.GPSLatitudeRef]: lat >= 0 ? "N" : "S",
    [piexif.GPSIFD.GPSLatitude]: toDMSRationals(lat),
    [piexif.GPSIFD.GPSLongitudeRef]: lon >= 0 ? "E" : "W",
    [piexif.GPSIFD.GPSLongitude]: toDMSRationals(lon),
  }

  const exifBytes = piexif.dump({ "0th": zeroth, Exif: exif, GPS: gps })
  const inserted = piexif.insert(exifBytes, dataUrl)
  return dataUrlToFile(inserted, file.name, "image/jpeg")
}

async function injectVideoMetadata(file: File): Promise<File> {
  const { fetchFile } = await import("@ffmpeg/util")
  const data = await fetchFile(file)
  const phone = pick(IPHONES)
  const { lat, lon } = randomUsLocation()
  // ISO-6709 string, e.g. "+40.7128-074.0060/".
  const iso6709 = `${lat >= 0 ? "+" : "-"}${Math.abs(lat).toFixed(4)}${lon >= 0 ? "+" : "-"}${Math.abs(lon)
    .toFixed(4)
    .padStart(8, "0")}/`

  return withFfmpeg(undefined, async (ff, id) => {
    const inName = `meta-in-${id}.mp4`
    const outName = `meta-out-${id}.mp4`
    await ff.writeFile(inName, data)

    // Copy streams (no re-encode) and just rewrite container metadata.
    await ff.exec([
      "-i",
      inName,
      "-c",
      "copy",
      "-metadata",
      "make=Apple",
      "-metadata",
      `model=${phone.model}`,
      "-metadata",
      `com.apple.quicktime.make=Apple`,
      "-metadata",
      `com.apple.quicktime.model=${phone.model}`,
      "-metadata",
      `com.apple.quicktime.software=${phone.software}`,
      "-metadata",
      `com.apple.quicktime.location.ISO6709=${iso6709}`,
      "-metadata",
      `location=${iso6709}`,
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outName,
    ])

    const out = await ff.readFile(outName)
    await ff.deleteFile(inName)
    await ff.deleteFile(outName)
    const blob = new Blob([out as Uint8Array], { type: "video/mp4" })
    return new File([blob], file.name, { type: "video/mp4" })
  })
}

// Stamp iPhone capture metadata + a US GPS location onto a file before upload.
// Best-effort: on any failure the original file is returned untouched.
export async function stampIphoneMetadata(file: File, kind: "image" | "video"): Promise<File> {
  try {
    return kind === "video" ? await injectVideoMetadata(file) : await injectImageMetadata(file)
  } catch (err) {
    console.log("[v0] metadata stamp failed, using original:", err)
    return file
  }
}
