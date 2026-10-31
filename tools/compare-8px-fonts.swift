import Foundation
import CoreGraphics
import CoreText
import ImageIO
import CryptoKit

struct Candidate {
    let name: String
    let path: String
    let size: CGFloat
    let native: Bool
    let note: String
    var outline: Bool = false
    var fillHeight: Bool = false
}

let nativeRank = CommandLine.arguments.dropFirst().contains("--native-rank")
let handDialogue = CommandLine.arguments.dropFirst().contains("--hand-dialogue")
precondition(!(nativeRank && handDialogue), "Choose one preview mode")
let candidates = nativeRank ? [
    Candidate(name: "G  Installed Miseki Mincho", path: "assets/fonts/miseki-bitmap-1.15.2/MisekiBitmapMincho.ttf", size: 8, native: true,
              note: "Current glyph shapes / original 8x8 cells", outline: true),
    Candidate(name: "H  Full-height experiment", path: "assets/fonts/miseki-bitmap-1.15.2/MisekiBitmapMincho.ttf", size: 8, native: true,
              note: "CJK ink height expanded to 8px / original width and spacing / preview only", outline: true, fillHeight: true),
] : [
    Candidate(name: "A  Fusion Pixel 8px / zh-Hant", path: "assets/fonts/fusion-pixel-2026.09.01/fusion-pixel-8px-monospaced-zh_hant.ttf", size: 8, native: true,
              note: "Native 8px / current supplemental font"),
    Candidate(name: "B  Misaki Gothic", path: "build/font-comparison-assets/misaki_gothic.ttf", size: 8, native: true,
              note: "Native 8px / Japanese glyph forms / incomplete Traditional Chinese coverage"),
    Candidate(name: "C  Misaki Mincho", path: "build/font-comparison-assets/misaki_mincho.ttf", size: 8, native: true,
              note: "Native 8px / Misaki variant: mainly kana and symbols differ; kanji largely shared"),
    Candidate(name: "D  Misaki Gothic 2nd", path: "build/font-comparison-assets/misaki_gothic_2nd.ttf", size: 8, native: true,
              note: "Native 8px / Misaki variant: mainly Latin and kana differ; kanji largely shared"),
    Candidate(name: "E  Boutique Bitmap 7x7 v1.71", path: "build/font-comparison-assets/BoutiqueBitmap7x7_1.71.ttf", size: 8, native: true,
              note: "Native 7x7 design in 8x8 cells / Traditional Chinese / also a Fusion upstream"),
    Candidate(name: "F  Miseki Bitmap v1.15.2", path: "build/font-comparison-assets/MisekiBitmap.ttf", size: 8, native: true,
              note: "Native 8px outlines / Misaki-derived Chinese coverage / embedded bitmap bypassed", outline: true),
    Candidate(name: "G  Miseki Bitmap Mincho v1.15.2", path: "build/font-comparison-assets/MisekiBitmapMincho.ttf", size: 8, native: true,
              note: "Native 8px outlines / Miseki Mincho variant / embedded bitmap bypassed", outline: true),
]
let lines = (nativeRank ? ["\u{514D}\u{8A31}\u{7686}\u{4F1D}\u{FF0F}\u{514D}\u{8A31}\u{7686}\u{50B3}"] : []) + [
    "\u{6843}\u{592A}\u{90CE}\u{FF0C}\u{9285}\u{50CF}\u{5230}\u{5E95}\u{8DD1}\u{5230}\u{54EA}\u{88E1}\u{53BB}\u{4E86}\u{FF1F}",
    "\u{8ACB}\u{5E36}\u{8457}\u{7FBD}\u{6BDB}\u{64A2}\u{5B50}\u{FF0C}\u{524D}\u{5F80}\u{4E26}\u{6392}\u{6D1E}\u{7A9F}\u{3002}",
    "\u{8B1D}\u{8B1D}\u{4F60}\u{FF01}\u{8B93}\u{8CA7}\u{7AAE}\u{795E}\u{628A}\u{9285}\u{50CF}\u{642C}\u{56DE}\u{5EE3}\u{5834}\u{3002}",
    "HP 123/456  MP 78  + - = ! ?",
]
let difficult = "\u{9AD4}\u{9B31}\u{9F8D}\u{8B93}\u{9084}\u{908A}\u{8B80}\u{96E3}\u{9435}\u{5BF6}\u{8B8A}\u{9A57}\u{64A2}\u{7AAE}\u{50CF}\u{9285}"
let corpus = try JSONDecoder().decode([String].self, from: Data(contentsOf: URL(fileURLWithPath: "build/dialogue-characters.json")))
let samples = Array(Set((lines.joined() + difficult).map(String.init))).sorted()

func raster(_ character: String, font: CTFont, native: Bool, outline: Bool) -> (pixels: [UInt8]?, issue: String?) {
    if character == " " { return (Array(repeating: 0, count: 64), nil) }
    guard character.utf16.count == 1 else { return (nil, "non-BMP") }
    var scalar = character.utf16.first!
    var glyph: CGGlyph = 0
    guard CTFontGetGlyphsForCharacters(font, &scalar, &glyph, 1), glyph != 0 else { return (nil, "missing") }
    let path = outline ? CTFontCreatePathForGlyph(font, glyph, nil) : nil
    if outline && path == nil { return (nil, "missing-outline") }
    let bounds = (path?.boundingBoxOfPath ?? CTFontGetBoundingRectsForGlyphs(font, .default, &glyph, nil, 1)).integral
    guard bounds.width <= 8 && bounds.height <= 8 else { return (nil, "exceeds-8x8") }
    var bitmap = [UInt8](repeating: 0, count: 64)
    bitmap.withUnsafeMutableBytes { storage in
        let context = CGContext(data: storage.baseAddress, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 8,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        context.setFillColor(gray: 1, alpha: 1)
        context.setShouldAntialias(!native)
        context.setShouldSmoothFonts(false)
        var position = CGPoint(x: (8 - bounds.width) / 2 - bounds.minX, y: (8 - bounds.height) / 2 - bounds.minY)
        if native { position.x = floor(position.x); position.y = floor(position.y) }
        if let path {
            context.translateBy(x: position.x, y: position.y)
            context.addPath(path)
            context.fillPath()
        } else {
            CTFontDrawGlyphs(font, &glyph, &position, 1, context)
        }
    }
    guard let peak = bitmap.max(), peak > 0 else { return (nil, "empty") }
    if native { precondition(bitmap.allSatisfy { $0 == 0 || $0 == 255 }) }
    let threshold = native ? UInt8(128) : min(UInt8(96), peak)
    return (bitmap.map { $0 >= threshold ? 1 : 0 }, nil)
}

let width = 1240
let rowHeight = nativeRank ? 370 : 328
let headerHeight = nativeRank ? 244 : 128
let height = handDialogue ? 700 : headerHeight + 48 + candidates.count * rowHeight
let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.translateBy(x: 0, y: CGFloat(height))
context.scaleBy(x: 1, y: -1)
func fill(_ rect: CGRect, _ color: CGColor) {
    context.setFillColor(color)
    context.fill(rect)
}
let ink = CGColor(gray: 0.08, alpha: 1)
let white = CGColor(gray: 1, alpha: 1)
let red = CGColor(red: 0.85, green: 0.12, blue: 0.12, alpha: 1)
fill(CGRect(x: 0, y: 0, width: width, height: height), white)

func label(_ text: String, x: Int, y: Int, size: CGFloat = 16, color: CGColor = CGColor(gray: 0.08, alpha: 1)) {
    let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
    let string = NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ])
    context.saveGState()
    context.translateBy(x: CGFloat(x), y: CGFloat(y) + size)
    context.scaleBy(x: 1, y: -1)
    context.textMatrix = .identity
    CTLineDraw(CTLineCreateWithAttributedString(string), context)
    context.restoreGState()
}

func draw(_ text: String, glyphs: [String: [UInt8]], x: Int, y: Int, scale: Int, dark: Bool = true, gap: Int = 0) {
    let background = dark ? ink : white
    let foreground = dark ? white : ink
    fill(CGRect(x: x, y: y, width: text.count * (8 * scale + gap), height: 8 * scale), background)
    for (index, character) in text.enumerated() {
        let left = x + index * (8 * scale + gap)
        if let pixels = glyphs[String(character)] {
            precondition(pixels.count == 64 && pixels.allSatisfy { $0 == 0 || $0 == 1 })
            for row in 0..<8 {
                for column in 0..<8 where pixels[row * 8 + column] != 0 {
                    fill(CGRect(x: left + column * scale, y: y + row * scale, width: scale, height: scale), foreground)
                }
            }
        } else {
            for position in 0..<8 {
                fill(CGRect(x: left + position * scale, y: y + position * scale, width: scale, height: scale), red)
                fill(CGRect(x: left + (7 - position) * scale, y: y + position * scale, width: scale, height: scale), red)
            }
        }
    }
}

if handDialogue {
    let installed = try Data(contentsOf: URL(fileURLWithPath: "build/score-fix-miseki-QCwnps/glyphs.bin"))
    let native = try Data(contentsOf: URL(fileURLWithPath: "build/font-2f9878.bin"))
    precondition(installed.count == corpus.count * 32 && native.count == 1824)
    func unpackTile(_ data: Data, _ index: Int) -> [UInt8] {
        (0..<64).map { pixel in
            let value = (data[index * 32 + pixel / 2] >> ((pixel % 2) * 4)) & 15
            precondition(value == 1 || value == 2)
            return value == 2 ? 1 : 0
        }
    }
    var current = Dictionary(uniqueKeysWithValues: corpus.enumerated().map {
        ($0.element, unpackTile(installed, $0.offset))
    })
    let rows: [String: [UInt8]] = [
        "\u{80FD}": [0x24, 0x56, 0xf4, 0x06, 0x76, 0x54, 0x76, 0x56],
        "\u{548C}": [0x30, 0x6e, 0x2a, 0xfa, 0x2a, 0x7a, 0xaa, 0x2e],
        "\u{5728}": [0x20, 0xfe, 0x20, 0x48, 0x5c, 0xc8, 0x48, 0x7e],
        "\u{8D77}": [0x2e, 0xf2, 0x22, 0xfe, 0xa8, 0xae, 0xa0, 0x7e],
        "\u{6211}": [0x1a, 0x68, 0x28, 0xfe, 0x2a, 0x3c, 0xe8, 0x36],
        "\u{4E5F}": [0x10, 0x50, 0x5e, 0x72, 0xd2, 0x56, 0x40, 0x3e],
        "\u{73A9}": [0xdc, 0x40, 0x5c, 0xfe, 0x54, 0x54, 0xd4, 0x26],
        "\u{5F97}": [0x5c, 0x94, 0x5c, 0x80, 0xfe, 0x44, 0x54, 0x4c],
        "\u{597D}": [0x2e, 0x22, 0x24, 0xfe, 0x54, 0x64, 0x54, 0x8c],
        "\u{958B}": [0xee, 0xaa, 0xee, 0x82, 0xfe, 0xaa, 0xfe, 0xaa],
        "\u{5FC3}": [0x20, 0x10, 0x00, 0x24, 0x62, 0xa2, 0x24, 0x1c],
    ]
    var proposal = current
    for (character, bitmapRows) in rows {
        precondition(corpus.contains(character) && bitmapRows.count == 8)
        let pixels: [UInt8] = bitmapRows.flatMap { row in
            (0..<8).map { column in row & (0x80 >> column) == 0 ? UInt8(0) : UInt8(1) }
        }
        precondition(pixels.contains(1) && pixels != current[character])
        proposal[character] = pixels
    }
    let collisions = Dictionary(grouping: corpus, by: { proposal[$0]! }).values.filter { $0.count > 1 }
    precondition(collisions.isEmpty, "Hand glyph collides with another corpus glyph")
    precondition(corpus.filter { current[$0] != proposal[$0] }.count == rows.count)
    for (index, character) in "\u{6843}\u{592A}\u{90CE}".enumerated() {
        current[String(character)] = unpackTile(native, index)
        proposal[String(character)] = unpackTile(native, index)
    }
    let dialogue = ["\u{80FD}\u{548C}\u{6843}\u{592A}\u{90CE}\u{5728}\u{4E00}\u{8D77}\u{FF0C}",
                    "\u{6211}\u{4E5F}\u{73A9}\u{5F97}\u{597D}\u{958B}\u{5FC3}\u{FF01}"]
    precondition(dialogue.joined().allSatisfy { proposal[String($0)] != nil })
    label("DIALOGUE PIXEL STUDY / 11 HAND-EDITED GLYPHS", x: 28, y: 20, size: 26)
    label("Original Momotarou tiles in BOTH samples. Same 8x8 cells, spacing and magnification.", x: 28, y: 59)
    for (index, glyphs) in [current, proposal].enumerated() {
        let top = 110 + index * 245
        label(index == 0 ? "G / installed glyphs + original name" : "I / hand-edited draft + original name", x: 28, y: top, size: 22)
        for (row, text) in dialogue.enumerated() {
            draw(text, glyphs: glyphs, x: 28, y: top + 44 + row * 84, scale: 8)
            draw(text, glyphs: glyphs, x: 700, y: top + 44 + row * 36, scale: 3)
            draw(text, glyphs: glyphs, x: 1020, y: top + 44 + row * 16, scale: 1)
        }
        label("8x / exact pixels", x: 28, y: top + 205, size: 14)
        label("3x", x: 700, y: top + 124, size: 14)
        label("1x", x: 1020, y: top + 89, size: 14)
    }
    label("Draft only: readability needs review. Not a complete font. ROM and handheld unchanged.", x: 28, y: 663, size: 16)
    let prefix = "build/font-comparison-hand-dialogue"
    let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: "\(prefix).png") as CFURL, "public.png" as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(destination))
    let report: [String: Any] = ["cellSize": 8, "lines": dialogue, "editedRows": rows,
        "editedCount": rows.count, "corpusCollisionCount": collisions.count,
        "originalNamePreserved": true, "status": "hand-edited-preview-only",
        "baselineSha256": SHA256.hash(data: installed).map { String(format: "%02x", $0) }.joined()]
    try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        .write(to: URL(fileURLWithPath: "\(prefix).json"))
    print("\(prefix).png: \(rows.count) edited glyphs, no collisions across \(corpus.count) glyphs; original name retained")
    exit(0)
}

label("8 x 8 FONT COMPARISON", x: 28, y: 20, size: 28)
label("Every character stays inside one 8x8 cell. Identical text and spacing. No fallback fonts.", x: 28, y: 60)
label("Red X = missing, empty or oversized glyph. 4x / 6x views use exact pixel replication, no smoothing.", x: 28, y: 84)
if nativeRank {
    let tiles = try Data(contentsOf: URL(fileURLWithPath: "build/font-2f9878.bin"))
    precondition(tiles.count == 1824)
    var nativeGlyphs: [String: [UInt8]] = [:]
    for (index, character) in "\u{514D}\u{8A31}\u{7686}\u{4F1D}".enumerated() {
        let offset = (index + 3) * 32
        nativeGlyphs[String(character)] = (0..<64).map { pixel in
            let value = (tiles[offset + pixel / 2] >> ((pixel % 2) * 4)) & 15
            precondition(value == 1 || value == 2)
            return value == 2 ? 1 : 0
        }
    }
    label("Original ROM rank tiles / 4x / four 8x8 cells (Japanese forms)", x: 28, y: 117)
    draw("\u{514D}\u{8A31}\u{7686}\u{4F1D}", glyphs: nativeGlyphs, x: 28, y: 149, scale: 4)
}
var reports: [[String: Any]] = []
var baseline: [String: [UInt8]] = [:]
for (index, candidate) in candidates.enumerated() {
    guard let provider = CGDataProvider(url: URL(fileURLWithPath: candidate.path) as CFURL),
          let graphicsFont = CGFont(provider) else { fatalError("Cannot open \(candidate.path)") }
    let font = CTFontCreateWithGraphicsFont(graphicsFont, candidate.size, nil, nil)
    var glyphs: [String: [UInt8]] = [:]
    var issues: [String: String] = [:]
    for character in Set(corpus + samples) {
        let result = raster(character, font: font, native: candidate.native, outline: candidate.outline)
        if let pixels = result.pixels {
                if candidate.fillHeight, let scalar = character.unicodeScalars.first,
               (0x3400...0x9fff).contains(scalar.value) {
                let occupied = pixels.indices.filter { pixels[$0] != 0 }
                let top = occupied.map { $0 / 8 }.min()!
                let inkHeight = occupied.map { $0 / 8 }.max()! - top + 1
                glyphs[character] = (0..<64).map { pixel in
                    let column = pixel % 8
                    let row = top + ((pixel / 8) * 2 + 1) * inkHeight / 16
                    return pixels[row * 8 + column]
                }
            } else {
                glyphs[character] = pixels
            }
        }
        if let issue = result.issue { issues[character] = issue }
    }
    let covered = corpus.filter { glyphs[$0] != nil }.count
    if index == 0 { baseline = glyphs }
    let identical = corpus.filter { glyphs[$0] != nil && glyphs[$0] == baseline[$0] }.count
    let groups = Dictionary(grouping: corpus.filter { glyphs[$0] != nil }, by: { glyphs[$0]! })
    let collisions = groups.values.filter { $0.count > 1 }.map { $0.sorted() }
    if nativeRank {
        precondition(covered == corpus.count && collisions.isEmpty, "Incomplete or colliding corpus glyphs")
        if !candidate.fillHeight {
            let installed = try Data(contentsOf: URL(fileURLWithPath: "build/score-fix-miseki-QCwnps/glyphs.bin"))
            precondition(installed.count == corpus.count * 32)
            for (glyphIndex, character) in corpus.enumerated() {
                for pixel in 0..<64 {
                    let value = (installed[glyphIndex * 32 + pixel / 2] >> ((pixel % 2) * 4)) & 15
                    precondition(glyphs[character]![pixel] == (value == 2 ? 1 : 0), "Baseline differs from installed glyphs")
                }
            }
        }
    }
    let top = headerHeight + index * rowHeight
    fill(CGRect(x: 28, y: top, width: 1184, height: 1), CGColor(gray: 0.8, alpha: 1))
    label(candidate.name, x: 28, y: top + 10, size: 23)
    label(candidate.note, x: 28, y: top + 41, size: 14)
    label("Project supplement: \(covered)/\(corpus.count) fit / \(identical) pixel-identical to \(nativeRank ? "G" : "A")", x: 28, y: top + 63, size: 14)
    label("4x", x: 28, y: top + 88, size: 13)
    label("1x (actual 8-pixel cells)", x: 936, y: top + 88, size: 13)
    for (row, text) in lines.enumerated() {
        draw(text, glyphs: glyphs, x: 28, y: top + 111 + row * 39, scale: 4)
        draw(text, glyphs: glyphs, x: 936, y: top + 112 + row * 12, scale: 1)
    }
    label("6x / dense characters", x: 936, y: top + 213, size: 13)
    draw(difficult, glyphs: glyphs, x: 28, y: top + rowHeight - 57, scale: 6, dark: false, gap: 5)
    label(difficult, x: 936, y: top + 239, size: 15)
    reports.append(["name": candidate.name, "path": candidate.path, "pointSize": candidate.size,
                    "native": candidate.native, "covered": covered, "total": corpus.count,
                    "outline": candidate.outline,
                    "fillHeight": candidate.fillHeight, "collisions": collisions,
                    "identicalToA": identical,
                    "sha256": SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: candidate.path))).map { String(format: "%02x", $0) }.joined(),
                    "issues": issues, "samplePixels": glyphs.filter { samples.contains($0.key) }])
}
label("Preview only. ROM, saves and handheld files are unchanged. Coverage is not an in-game compatibility test.", x: 28, y: height - 25, size: 14)
let prefix = nativeRank ? "build/font-comparison-native-rank" : "build/font-comparison-8x8"
let output = "\(prefix).png"
guard let image = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.png" as CFString, 1, nil) else {
    fatalError("Cannot create PNG")
}
CGImageDestinationAddImage(destination, image, nil)
precondition(CGImageDestinationFinalize(destination))
let report: [String: Any] = ["cellSize": 8, "lines": lines, "denseCharacters": difficult, "candidates": reports]
try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: "\(prefix).json"))
for report in reports { print("\(report["name"]!): \(report["covered"]!)/\(report["total"]!)") }
print(output)