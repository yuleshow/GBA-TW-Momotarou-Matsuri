import Foundation
import CoreGraphics
import CoreText
import ImageIO

struct Settlement: Decodable {
    let mapId: Int
    let name: String
    let column: Int
    let row: Int
}
struct MapReport: Decodable {
    let width: Int
    let height: Int
    let settlements: [Settlement]
}
let report = try JSONDecoder().decode(MapReport.self, from: Data(contentsOf: URL(fileURLWithPath: "build/world-map.json")))
let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: "build/world-map.png") as CFURL, nil)!
let image = CGImageSourceCreateImageAtIndex(source, 0, nil)!
precondition(image.width == report.width && image.height == report.height)
let context = CGContext(data: nil, width: report.width, height: report.height, bitsPerComponent: 8,
                        bytesPerRow: report.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
context.draw(image, in: CGRect(x: 0, y: 0, width: report.width, height: report.height))
context.translateBy(x: 0, y: CGFloat(report.height))
context.scaleBy(x: 1, y: -1)
let font = CTFontCreateWithName("PingFangTC-Semibold" as CFString, 27, nil)
let white = CGColor(gray: 1, alpha: 1)
let ink = CGColor(gray: 0.06, alpha: 1)
let bounds = CGRect(x: 0, y: 0, width: report.width, height: report.height)
var labels: [CGRect] = []
for settlement in report.settlements {
    let anchor = CGPoint(x: settlement.column * 16 + 8, y: settlement.row * 16 + 8)
    let text = NSAttributedString(string: settlement.name, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font,
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): white,
    ])
    let line = CTLineCreateWithAttributedString(text)
    let textWidth = ceil(CTLineGetTypographicBounds(line, nil, nil, nil))
    let label = CGRect(x: anchor.x + 22, y: anchor.y - 22, width: textWidth + 20, height: 44)
    precondition(bounds.contains(label) && !labels.contains(where: { $0.intersects(label) }), "Label overlap or clipping")
    labels.append(label)
    context.setFillColor(ink.copy(alpha: 0.9)!)
    context.fill(label)
    context.setStrokeColor(white)
    context.setLineWidth(2)
    context.move(to: anchor)
    context.addLine(to: CGPoint(x: label.minX, y: label.midY))
    context.strokePath()
    context.setFillColor(CGColor(red: 0.87, green: 0.12, blue: 0.16, alpha: 1))
    context.fillEllipse(in: CGRect(x: anchor.x - 10, y: anchor.y - 10, width: 20, height: 20))
    context.strokeEllipse(in: CGRect(x: anchor.x - 10, y: anchor.y - 10, width: 20, height: 20))
    context.saveGState()
    context.translateBy(x: label.minX + 10, y: label.minY + 31)
    context.scaleBy(x: 1, y: -1)
    context.textMatrix = .identity
    CTLineDraw(line, context)
    context.restoreGState()
}
let output = "build/world-map-labeled.png"
let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: output) as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
precondition(CGImageDestinationFinalize(destination))
print("\(output): \(report.settlements.count) settlement labels, no overlapping labels")