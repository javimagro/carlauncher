param([Parameter(Mandatory=$true)][string]$Drawable, [Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore,WindowsBase
$culture = [Globalization.CultureInfo]::InvariantCulture
$android = 'http://schemas.android.com/apk/res/android'
$files = @{
    settings='ic_navigation_settings'; audio='ic_navigation_volume_on'; chargers='ic_navigation_charger'
    recent='ic_navigation_bookmark'; assistant='ic_navigation_assistant'; back='ic_navigation_reference_arrow_left'
    close='ic_navigation_reference_x'; next='ic_navigation_reference_chevron_right'; search='ic_navigation_reference_search'
    info='ic_navigation_reference_info'; check='ic_navigation_reference_check'; clock='ic_navigation_reference_clock_3'
    alert='ic_navigation_reference_triangle_alert'; 'zoom-in'='ic_navigation_reference_plus'; 'route-panel'='ic_navigation_reference_navigation'
}
New-Item -ItemType Directory -Path $Output -Force | Out-Null
function Number($node, $name, $fallback) {
    $v = $node.GetAttribute($name, $android)
    if ($v -eq '') { return [double]$fallback }
    return [double]::Parse($v, $culture)
}
function Paint-Nodes($context, $nodes) {
    foreach ($node in $nodes) {
        if ($node.Name -eq 'group') {
            $matrix = [Windows.Media.Matrix]::Identity
            $px = Number $node 'pivotX' 0; $py = Number $node 'pivotY' 0
            $matrix.ScaleAt((Number $node 'scaleX' 1), (Number $node 'scaleY' 1), $px, $py)
            $matrix.RotateAt((Number $node 'rotation' 0), $px, $py)
            $matrix.Translate((Number $node 'translateX' 0), (Number $node 'translateY' 0))
            $context.PushTransform([Windows.Media.MatrixTransform]::new($matrix))
            Paint-Nodes $context $node.ChildNodes
            $context.Pop()
        } elseif ($node.Name -eq 'path') {
            $geometry = [Windows.Media.Geometry]::Parse('F1 ' + $node.GetAttribute('pathData', $android))
            $fill = $node.GetAttribute('fillColor', $android)
            $brush = if ($fill -and $fill -ne '@android:color/transparent' -and $fill -ne '#00000000') { [Windows.Media.Brushes]::White } else { $null }
            $pen = $null
            if ($node.GetAttribute('strokeColor', $android)) {
                $pen = [Windows.Media.Pen]::new([Windows.Media.Brushes]::White, (Number $node 'strokeWidth' 1))
                if ($node.GetAttribute('strokeLineCap', $android) -eq 'round') { $pen.StartLineCap = 'Round'; $pen.EndLineCap = 'Round' }
                if ($node.GetAttribute('strokeLineJoin', $android) -eq 'round') { $pen.LineJoin = 'Round' }
            }
            $context.DrawGeometry($brush, $pen, $geometry)
        } elseif ($node.Name -eq 'clip-path') { throw 'Unsupported clipping must be handled explicitly' }
    }
}
$sources = @{}
foreach ($name in $files.Keys) {
    $source = Join-Path $Drawable ($files[$name] + '.xml')
    [xml]$xml = Get-Content -LiteralPath $source -Raw
    $visual = [Windows.Media.DrawingVisual]::new()
    $context = $visual.RenderOpen()
    $context.PushTransform([Windows.Media.ScaleTransform]::new(72 / (Number $xml.vector 'viewportWidth' 24), 72 / (Number $xml.vector 'viewportHeight' 24)))
    Paint-Nodes $context $xml.vector.ChildNodes
    $context.Pop(); $context.Close()
    $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new(72, 72, 96, 96, [Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($visual)
    $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [IO.File]::Create((Join-Path $Output ($name + '.png')))
    try { $encoder.Save($stream) } finally { $stream.Dispose() }
    $sources[$name] = @{file=('app/src/main/res/drawable/' + $files[$name] + '.xml'); sha256=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$sources | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Output 'sources.json') -Encoding utf8
