declare module "piexifjs" {
  interface IfdTags {
    [key: number]: unknown
  }
  interface ExifDict {
    "0th"?: IfdTags
    Exif?: IfdTags
    GPS?: IfdTags
    Interop?: IfdTags
    "1st"?: IfdTags
    thumbnail?: string | null
  }
  const piexif: {
    ImageIFD: Record<string, number>
    ExifIFD: Record<string, number>
    GPSIFD: Record<string, number>
    dump(data: ExifDict): string
    insert(exif: string, dataUrl: string): string
    load(dataUrl: string): ExifDict
    remove(dataUrl: string): string
  }
  export default piexif
}
