# Chrome ウェブストアへ提出する zip を作る。
# フォルダをそのまま zip すると、ストア掲載用の紹介動画・スクリーンショットや
# 作業用の音声ファイルまで同梱され、「機能と無関係なリソース」として審査で
# 指摘される。ここで同梱するものを明示的に列挙する。
#
#   powershell -ExecutionPolicy Bypass -File tools\pack.ps1
#
# 出力: dist\web-reader-for-voicevox-<version>.zip

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# manifest.json は BOM なし UTF-8。Windows PowerShell 5.1 の Get-Content は
# 既定で ANSI として読むため、必ず UTF-8 を明示する（日本語が壊れて JSON 解析に失敗する）。
$version = (Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
$stage = Join-Path $root 'dist\stage'
$zip = Join-Path $root "dist\web-reader-for-voicevox-$version.zip"

# 拡張の動作に必要なファイルだけを列挙する（docs/ は同梱しない。
# プライバシーポリシー・利用規約はストアのダッシュボードに URL で登録する）。
$files = @(
    'manifest.json',
    'background-entry.js', 'background-security.js', 'background.js',
    'content-guard.js', 'content.js', 'dom-text.js', 'offscreen-security.js', 'offscreen.js',
    'options.js', 'capture.js', 'constants.js',
    'ocr-common.js', 'ocr-image.js', 'ocr-refine.js',
    'offscreen.html', 'options.html', 'capture.html',
    'options.css', 'capture.css',
    'ocr-words.txt', 'ocr-dictionary-NOTICE.md',
    'LICENSE', 'LICENSE-APACHE-2.0'
)
$dirs = @('vendor')
$iconGlob = 'images\icon*.png'

if (Test-Path (Split-Path $stage -Parent)) { Remove-Item (Split-Path $stage -Parent) -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($f in $files) {
    if (-not (Test-Path $f)) { throw "同梱対象が見つかりません: $f" }
    Copy-Item $f (Join-Path $stage $f)
}
foreach ($d in $dirs) {
    if (-not (Test-Path $d)) { throw "同梱対象が見つかりません: $d" }
    Copy-Item $d (Join-Path $stage $d) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $stage 'images') -Force | Out-Null
$icons = Get-ChildItem $iconGlob
if ($icons.Count -eq 0) { throw 'images\icon*.png が見つかりません' }
Copy-Item $iconGlob (Join-Path $stage 'images')

# Compress-Archive（PowerShell 5.1）はエントリ名の区切りに「\」を使うため、
# 解凍側によってはフォルダ構造が失われる。ZIP 仕様どおり「/」で書く実装を使う。
# .NET Framework の CreateFromDirectory も Windows では「\」を書くため、
# エントリ名を自前で「/」に直しながら詰める。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path $zip) { Remove-Item $zip -Force }
$archive = [IO.Compression.ZipFile]::Open($zip, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($item in Get-ChildItem $stage -Recurse -File) {
        $name = $item.FullName.Substring($stage.Length + 1).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $archive, $item.FullName, $name, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose() }
Remove-Item $stage -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output "作成しました: $zip ($size MB)"
