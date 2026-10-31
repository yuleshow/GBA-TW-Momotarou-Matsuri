import Foundation
import CoreGraphics
import CoreText

guard (4...7).contains(CommandLine.arguments.count) else {
    fatalError("Usage: rasterize-font CHARACTER_LIST_JSON OUTPUT_BIN FONT_TTF [POINT_SIZE] [CELL_SIZE] [--outline]")
}
let outline = CommandLine.arguments.count == 7
guard !outline || CommandLine.arguments[6] == "--outline" else { fatalError("Expected --outline") }
let input = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
let characters = try JSONDecoder().decode([String].self, from: input)
let fontURL = URL(fileURLWithPath: CommandLine.arguments[3])
guard let provider = CGDataProvider(url: fontURL as CFURL),
      let graphicsFont = CGFont(provider) else { fatalError("Cannot load pixel font") }
let pointSize = CommandLine.arguments.count >= 5 ? Double(CommandLine.arguments[4]) : 8
guard let pointSize, pointSize.isFinite, pointSize > 0 else { fatalError("Invalid point size") }
let cellSize = CommandLine.arguments.count >= 6 ? Int(CommandLine.arguments[5]) : 8
guard let cellSize, [8, 10, 16].contains(cellSize) else { fatalError("Expected 8, 10 or 16 pixel cell") }
let font = CTFontCreateWithGraphicsFont(graphicsFont, CGFloat(pointSize), nil, nil)
let nativePixels = cellSize != 8 || pointSize == 8
var output = Data()
for character in characters {
    guard character.utf16.count == 1 else { fatalError("Expected one BMP character") }
    var scalar = Array(character.utf16)[0]
    var glyph: CGGlyph = 0
    guard CTFontGetGlyphsForCharacters(font, &scalar, &glyph, 1), glyph != 0 else {
        fatalError("Missing glyph: \(character)")
    }
    let path = outline ? CTFontCreatePathForGlyph(font, glyph, nil) : nil
    guard !outline || path != nil else { fatalError("Missing glyph outline: \(character)") }
    var bitmap = [UInt8](repeating: 0, count: cellSize * cellSize)
    bitmap.withUnsafeMutableBytes { storage in
        let context = CGContext(data: storage.baseAddress, width: cellSize, height: cellSize,
                    bitsPerComponent: 8, bytesPerRow: cellSize,
                                space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: cellSize, height: cellSize))
        context.setFillColor(gray: 1, alpha: 1)
        context.setShouldAntialias(!nativePixels)
        context.setShouldSmoothFonts(false)
        var bounds = path?.boundingBoxOfPath ?? CTFontGetBoundingRectsForGlyphs(font, .default, &glyph, nil, 1)
        bounds = bounds.integral
        guard bounds.width <= CGFloat(cellSize) && bounds.height <= CGFloat(cellSize) else {
            fatalError("Glyph exceeds \(cellSize)x\(cellSize): \(character) \(bounds)")
        }
        var position = CGPoint(x: (CGFloat(cellSize) - bounds.width) / 2 - bounds.minX,
                               y: (CGFloat(cellSize) - bounds.height) / 2 - bounds.minY)
        if nativePixels {
            position.x = floor(position.x)
            position.y = floor(position.y)
        }
        if let path {
            context.translateBy(x: position.x, y: position.y)
            context.addPath(path)
            context.fillPath()
        } else {
            CTFontDrawGlyphs(font, &glyph, &position, 1, context)
        }
    }
    guard let peakCoverage = bitmap.max(), peakCoverage > 0 else {
        fatalError("Empty rasterized glyph: \(character)")
    }
    if nativePixels && bitmap.contains(where: { $0 != 0 && $0 != 255 }) {
        fatalError("Expected native monochrome pixels: \(character)")
    }
    let threshold = nativePixels ? UInt8(128) : min(UInt8(96), peakCoverage)
    if cellSize == 10 {
        output.append(contentsOf: bitmap.map { $0 >= threshold ? UInt8(2) : UInt8(1) })
        continue
    }
    for tileRow in 0..<(cellSize / 8) {
        for tileColumn in 0..<(cellSize / 8) {
            for row in 0..<8 {
                for pair in 0..<4 {
                    let index = (tileRow * 8 + row) * cellSize + tileColumn * 8 + pair * 2
                    let left: UInt8 = bitmap[index] >= threshold ? 2 : 1
                    let right: UInt8 = bitmap[index + 1] >= threshold ? 2 : 1
                    output.append(left | (right << 4))
                }
            }
        }
    }
}
try output.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
print("Rasterized \(characters.count) experimental \(cellSize)x\(cellSize) glyphs using \(CTFontCopyPostScriptName(font))")