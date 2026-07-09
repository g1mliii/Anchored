param(
    [string]$SourceDir = "extension",
    [string]$OutputDir = "versioned_zips",
    [string]$StartVersion = "10.1",
    [string]$EndVersion = "15.0",
    [string]$BaselineZip = "versioned_zips\10.0.zip"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-VersionSequence {
    param(
        [string]$Start,
        [string]$End
    )

    $versions = New-Object System.Collections.Generic.List[string]
    $current = [decimal]$Start
    $limit = [decimal]$End

    while ($current -le $limit) {
        $versions.Add(($current).ToString("0.0"))
        $current += [decimal]"0.1"
    }

    return $versions
}

function Get-RelativePath {
    param(
        [string]$BasePath,
        [string]$ChildPath
    )

    $normalizedBase = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $normalizedChild = [System.IO.Path]::GetFullPath($ChildPath)

    if ($normalizedChild.StartsWith($normalizedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $normalizedChild.Substring($normalizedBase.Length)
    }

    return $normalizedChild
}

function Remove-FullLineMatches {
    param(
        [string]$FilePath,
        [string]$Pattern
    )

    $lines = Get-Content -LiteralPath $FilePath
    $filtered = foreach ($line in $lines) {
        if ($line -notmatch $Pattern) {
            $line
        }
    }

    Set-Content -LiteralPath $FilePath -Value $filtered
}

function Collapse-BlankLines {
    param(
        [string]$FilePath
    )

    $lines = Get-Content -LiteralPath $FilePath
    $buffer = New-Object System.Collections.Generic.List[string]
    $previousBlank = $false

    foreach ($line in $lines) {
        $isBlank = $line -match '^\s*$'
        if ($isBlank -and $previousBlank) {
            continue
        }

        $buffer.Add($line)
        $previousBlank = $isBlank
    }

    while ($buffer.Count -gt 0 -and $buffer[$buffer.Count - 1] -match '^\s*$') {
        $buffer.RemoveAt($buffer.Count - 1)
    }

    Set-Content -LiteralPath $FilePath -Value $buffer
}

function Remove-FullLineMatchesFromFiles {
    param(
        [string]$BaseDirectory,
        [string[]]$RelativePaths,
        [string]$Pattern
    )

    foreach ($relativePath in $RelativePaths) {
        Remove-FullLineMatches -FilePath (Join-Path $BaseDirectory $relativePath) -Pattern $Pattern
    }
}

function Collapse-BlankLinesFromFiles {
    param(
        [string]$BaseDirectory,
        [string[]]$RelativePaths
    )

    foreach ($relativePath in $RelativePaths) {
        Collapse-BlankLines -FilePath (Join-Path $BaseDirectory $relativePath)
    }
}

function Get-StageFilePath {
    param(
        [string]$StageExtensionDir,
        [string]$RelativePath
    )

    return Join-Path $StageExtensionDir $RelativePath
}

function Set-FileLines {
    param(
        [string]$FilePath,
        [System.Collections.Generic.List[string]]$Lines
    )

    Set-Content -LiteralPath $FilePath -Value $Lines
}

function Replace-Line {
    param(
        [string]$FilePath,
        [string]$OldLine,
        [string[]]$NewLines,
        [int]$ExpectedCount = 1
    )

    $lines = Get-Content -LiteralPath $FilePath
    $updated = New-Object System.Collections.Generic.List[string]
    $matches = 0

    foreach ($line in $lines) {
        if ($line -ceq $OldLine) {
            foreach ($newLine in $NewLines) {
                $updated.Add($newLine)
            }
            $matches++
        }
        else {
            $updated.Add($line)
        }
    }

    if ($matches -ne $ExpectedCount) {
        throw "Expected $ExpectedCount line replacement(s), found $matches in $FilePath for: $OldLine"
    }

    Set-FileLines -FilePath $FilePath -Lines $updated
}

function Insert-LinesBefore {
    param(
        [string]$FilePath,
        [string]$AnchorLine,
        [string[]]$NewLines,
        [int]$ExpectedCount = 1
    )

    $lines = Get-Content -LiteralPath $FilePath
    $updated = New-Object System.Collections.Generic.List[string]
    $matches = 0

    foreach ($line in $lines) {
        if ($line -ceq $AnchorLine) {
            foreach ($newLine in $NewLines) {
                $updated.Add($newLine)
            }
            $matches++
        }

        $updated.Add($line)
    }

    if ($matches -ne $ExpectedCount) {
        throw "Expected $ExpectedCount insertion anchor(s), found $matches in $FilePath for: $AnchorLine"
    }

    Set-FileLines -FilePath $FilePath -Lines $updated
}

function Insert-LinesAfter {
    param(
        [string]$FilePath,
        [string]$AnchorLine,
        [string[]]$NewLines,
        [int]$ExpectedCount = 1
    )

    $lines = Get-Content -LiteralPath $FilePath
    $updated = New-Object System.Collections.Generic.List[string]
    $matches = 0

    foreach ($line in $lines) {
        $updated.Add($line)

        if ($line -ceq $AnchorLine) {
            foreach ($newLine in $NewLines) {
                $updated.Add($newLine)
            }
            $matches++
        }
    }

    if ($matches -ne $ExpectedCount) {
        throw "Expected $ExpectedCount insertion anchor(s), found $matches in $FilePath for: $AnchorLine"
    }

    Set-FileLines -FilePath $FilePath -Lines $updated
}

function Prepend-Lines {
    param(
        [string]$FilePath,
        [string[]]$NewLines
    )

    $lines = Get-Content -LiteralPath $FilePath
    $updated = New-Object System.Collections.Generic.List[string]

    foreach ($newLine in $NewLines) {
        $updated.Add($newLine)
    }

    foreach ($line in $lines) {
        $updated.Add($line)
    }

    Set-FileLines -FilePath $FilePath -Lines $updated
}

function Replace-Text {
    param(
        [string]$FilePath,
        [string]$OldText,
        [string]$NewText,
        [int]$ExpectedCount = 1
    )

    $content = Get-Content -LiteralPath $FilePath -Raw
    $oldCandidates = New-Object System.Collections.Generic.List[string]
    $oldCandidates.Add($OldText)

    if ($OldText.Contains("`n")) {
        $oldCandidates.Add(($OldText -replace "`r?`n", "`r`n"))
        $oldCandidates.Add(($OldText -replace "`r?`n", "`n"))
    }

    $selectedOldText = $null
    $matches = 0

    foreach ($candidate in $oldCandidates) {
        $candidateMatches = [regex]::Matches($content, [regex]::Escape($candidate)).Count
        if ($candidateMatches -eq $ExpectedCount) {
            $selectedOldText = $candidate
            $matches = $candidateMatches
            break
        }
        if ($candidateMatches -gt 0) {
            $matches = $candidateMatches
        }
    }

    if (-not $selectedOldText) {
        throw "Expected $ExpectedCount text replacement(s), found $matches in $FilePath for: $OldText"
    }

    if ($selectedOldText.Contains("`r`n")) {
        $replacementText = $NewText -replace "`r?`n", "`r`n"
    }
    else {
        $replacementText = $NewText -replace "`r?`n", "`n"
    }

    $content = $content.Replace($selectedOldText, $replacementText)
    Set-Content -LiteralPath $FilePath -Value $content -NoNewline
}

function Set-ManifestVersion {
    param(
        [string]$ManifestPath,
        [string]$Version
    )

    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $manifest.version = $Version
    $manifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $ManifestPath
}

function New-ZipFromDirectory {
    param(
        [string]$RootDirectory,
        [string]$ZipPath
    )

    if (Test-Path -LiteralPath $ZipPath) {
        Remove-Item -LiteralPath $ZipPath -Force
    }

    $zip = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $parentDirectory = Split-Path -Parent $RootDirectory
        $files = Get-ChildItem -LiteralPath $RootDirectory -Recurse -File | Sort-Object FullName

        foreach ($file in $files) {
            $entryName = (Get-RelativePath -BasePath $parentDirectory -ChildPath $file.FullName) -replace '\\', '/'
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip,
                $file.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            ) | Out-Null
        }
    }
    finally {
        $zip.Dispose()
    }
}

function Apply-CleanupStep {
    param(
        [string]$StageExtensionDir,
        [string]$Version
    )

    switch ($Version) {
        "5.1" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "popup\css\components.css") -Pattern '^\s*/\*.*\*/\s*$'
        }
        "5.2" {
            Collapse-BlankLines -FilePath (Join-Path $StageExtensionDir "popup\css\components.css")
        }
        "5.3" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "popup\popup.css") -Pattern '^\s*/\*.*\*/\s*$'
        }
        "5.4" {
            Collapse-BlankLines -FilePath (Join-Path $StageExtensionDir "popup\popup.css")
        }
        "5.5" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "background\background.js") -Pattern '^\s*//'
        }
        "5.6" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "content\content.js") -Pattern '^\s*//'
        }
        "5.7" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "content\content.css",
                "popup\dialog.css",
                "popup\css\settings.css",
                "popup\css\editor.css",
                "popup\css\animations.css"
            ) -Pattern '^\s*/\*.*\*/\s*$'
        }
        "5.8" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "popup\modules\user-engagement.js") -Pattern '^\s*//'
        }
        "5.9" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "popup\modules\export-formats.js") -Pattern '^\s*//'
        }
        "6.0" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\modules\editor.js",
                "popup\modules\storage.js",
                "popup\modules\utils.js"
            ) -Pattern '^\s*//'

            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\popup.html",
                "assets\create-icons.html"
            ) -Pattern '^\s*<!--.*-->\s*$'
        }
        "6.1" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "popup\modules\onboarding-tooltips.js") -Pattern '^\s*//'
        }
        "6.2" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\modules\notes.js",
                "popup\modules\settings.js",
                "popup\modules\dialog.js",
                "popup\modules\theming.js"
            ) -Pattern '^\s*//'
        }
        "6.3" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "lib\storage.js",
                "lib\ads.js",
                "lib\api.js",
                "lib\sync.js",
                "lib\xss-prevention.js",
                "lib\premium.js",
                "lib\input-validation.js",
                "lib\safe-dom.js"
            ) -Pattern '^\s*//'
        }
        "6.4" {
            Remove-FullLineMatches -FilePath (Join-Path $StageExtensionDir "popup\popup.js") -Pattern '^\s*//'
        }
        "6.5" {
            Collapse-BlankLines -FilePath (Join-Path $StageExtensionDir "popup\popup.js")
        }
        "6.6" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\modules\user-engagement.js",
                "popup\modules\export-formats.js",
                "popup\modules\editor.js",
                "popup\modules\onboarding-tooltips.js"
            )
        }
        "6.7" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\modules\notes.js",
                "popup\modules\settings.js",
                "popup\modules\storage.js",
                "popup\modules\utils.js"
            )
        }
        "6.8" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "background\background.js",
                "content\content.js",
                "lib\storage.js",
                "lib\ads.js",
                "lib\api.js"
            )
        }
        "6.9" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "lib\sync.js",
                "lib\xss-prevention.js",
                "lib\input-validation.js",
                "lib\safe-dom.js",
                "popup\modules\dialog.js",
                "popup\modules\theming.js",
                "popup\popup.html"
            )
        }
        "7.0" {
            $utils = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\utils.js"
            Insert-LinesAfter -FilePath $utils -AnchorLine "class Utils {" -NewLines @(
                "  static hasOwn(obj, key) {",
                "    return Object.prototype.hasOwnProperty.call(obj, key);",
                "  }",
                ""
            )
            Replace-Line -FilePath $utils -OldLine "        if (obj.hasOwnProperty(key)) {" -NewLines @("        if (Utils.hasOwn(obj, key)) {")
            Replace-Line -FilePath $utils -OldLine "      if (source.hasOwnProperty(key)) {" -NewLines @("      if (Utils.hasOwn(source, key)) {")
        }
        "7.1" {
            Replace-Line -FilePath (Get-StageFilePath $StageExtensionDir "popup\modules\utils.js") -OldLine "    return text.substring(0, maxLength) + '...';" -NewLines @("    return text.slice(0, maxLength) + '...';")
            Replace-Line -FilePath (Get-StageFilePath $StageExtensionDir "lib\safe-dom.js") -OldLine "      return input.substring(0, maxLength);" -NewLines @("      return input.slice(0, maxLength);")

            $validator = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\input-validation.js"
            Replace-Line -FilePath $validator -OldLine "            sanitized = sanitized.substring(0, this.maxLengths.title);" -NewLines @("            sanitized = sanitized.slice(0, this.maxLengths.title);")
            Replace-Line -FilePath $validator -OldLine "            sanitized = sanitized.substring(0, this.maxLengths.content);" -NewLines @("            sanitized = sanitized.slice(0, this.maxLengths.content);")
            Replace-Line -FilePath $validator -OldLine "                sanitizedTag = sanitizedTag.substring(0, this.maxLengths.tag);" -NewLines @("                sanitizedTag = sanitizedTag.slice(0, this.maxLengths.tag);")

            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Replace-Line -FilePath $content -OldLine "      text = text.substring(0, 8000) + '...';" -NewLines @("      text = text.slice(0, 8000) + '...';")
            Replace-Line -FilePath $content -OldLine "        let val = hash.substring(idx + marker.length);" -NewLines @("        let val = hash.slice(idx + marker.length);")
            Replace-Line -FilePath $content -OldLine "        val = val.substring(0, endIdx);" -NewLines @("        val = val.slice(0, endIdx);")
        }
        "7.2" {
            $config = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\config.js"
            Insert-LinesAfter -FilePath $config -AnchorLine "(function(){" -NewLines @(
                "  const CONFIG_STORAGE_KEYS = ['supabaseUrl', 'supabaseAnonKey'];",
                ""
            )
            Replace-Line -FilePath $config -OldLine "      const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(['supabaseUrl', 'supabaseAnonKey']);" -NewLines @("      const { supabaseUrl, supabaseAnonKey } = await chrome.storage.local.get(CONFIG_STORAGE_KEYS);")

            $theming = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\theming.js"
            Insert-LinesBefore -FilePath $theming -AnchorLine "class ThemeManager {" -NewLines @(
                "const ACCENT_CACHE_STORAGE_KEY = 'accentCache';",
                "const THEME_MODE_STORAGE_KEY = 'themeMode';",
                ""
            )
            Replace-Line -FilePath $theming -OldLine "    const { accentCache } = await chrome.storage.local.get(['accentCache']);" -NewLines @("    const { accentCache } = await chrome.storage.local.get([ACCENT_CACHE_STORAGE_KEY]);") -ExpectedCount 2
            Replace-Line -FilePath $theming -OldLine "    const { themeMode } = await chrome.storage.local.get(['themeMode']);" -NewLines @("    const { themeMode } = await chrome.storage.local.get([THEME_MODE_STORAGE_KEY]);")
        }
        "7.3" {
            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesBefore -FilePath $background -AnchorLine "async function checkNoteLimitBeforeCreate() {" -NewLines @(
                "function toIsoTimestamp() {",
                "  return new Date().toISOString();",
                "}",
                ""
            )
            Replace-Line -FilePath $background -OldLine "    createdAt: new Date().toISOString()," -NewLines @("    createdAt: toIsoTimestamp(),") -ExpectedCount 2
            Replace-Line -FilePath $background -OldLine "    updatedAt: new Date().toISOString()," -NewLines @("    updatedAt: toIsoTimestamp(),") -ExpectedCount 2
            Replace-Line -FilePath $background -OldLine "        updatedAt: new Date().toISOString()" -NewLines @("        updatedAt: toIsoTimestamp()")
            Replace-Line -FilePath $background -OldLine "          updatedAt: new Date().toISOString()" -NewLines @("          updatedAt: toIsoTimestamp()")
            Replace-Line -FilePath $background -OldLine "      targetNote.updatedAt = new Date().toISOString();" -NewLines @("      targetNote.updatedAt = toIsoTimestamp();")
            Replace-Line -FilePath $background -OldLine "        targetNote.updatedAt = new Date().toISOString();" -NewLines @("        targetNote.updatedAt = toIsoTimestamp();")
        }
        "7.4" {
            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Prepend-Lines -FilePath $background -NewLines @(
                "const FREE_NOTE_LIMIT = 50;",
                "const HTTP_URL_PREFIX = 'http';",
                "const NOTE_LIMIT_REACHED_MESSAGE = 'You\'ve reached the 50 note limit on the free plan. Upgrade to Premium for unlimited notes!';",
                ""
            )
            Replace-Line -FilePath $background -OldLine "  const FREE_NOTE_LIMIT = 50;" -NewLines @()
            Replace-Line -FilePath $background -OldLine "  if (!pageUrl || !pageUrl.startsWith('http')) {" -NewLines @("  if (!pageUrl || !pageUrl.startsWith(HTTP_URL_PREFIX)) {") -ExpectedCount 2
            Replace-Line -FilePath $background -OldLine "  if (!url || !url.startsWith('http')) {" -NewLines @("  if (!url || !url.startsWith(HTTP_URL_PREFIX)) {")
            Replace-Line -FilePath $background -OldLine "  if (!tab || !tab.url || !tab.url.startsWith('http')) {" -NewLines @("  if (!tab || !tab.url || !tab.url.startsWith(HTTP_URL_PREFIX)) {")
            Replace-Line -FilePath $background -OldLine "      message: 'You\'ve reached the 50 note limit on the free plan. Upgrade to Premium for unlimited notes!'," -NewLines @("      message: NOTE_LIMIT_REACHED_MESSAGE,") -ExpectedCount 2
        }
        "7.5" {
            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesBefore -FilePath $background -AnchorLine "async function checkNoteLimitBeforeCreate() {" -NewLines @(
                "function getStoredNoteKey(noteId) {",
                '  return `note_${noteId}`;',
                "}",
                ""
            )
            Replace-Line -FilePath $background -OldLine '    const key = `note_${newNote.id}`;' -NewLines @("    const key = getStoredNoteKey(newNote.id);") -ExpectedCount 2
            Replace-Line -FilePath $background -OldLine '      const key = `note_${targetNote.id}`;' -NewLines @("      const key = getStoredNoteKey(targetNote.id);")
            Replace-Line -FilePath $background -OldLine '        const key = `note_${targetNote.id}`;' -NewLines @("        const key = getStoredNoteKey(targetNote.id);")

            Replace-Line -FilePath (Get-StageFilePath $StageExtensionDir "lib\storage.js") -OldLine "          noteId: noteId," -NewLines @("          noteId,")
            Replace-Line -FilePath (Get-StageFilePath $StageExtensionDir "lib\storage.js") -OldLine "        noteId: noteId," -NewLines @("        noteId,")
        }
        "7.6" {
            $sync = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\sync.js"
            Insert-LinesBefore -FilePath $sync -AnchorLine "class SyncEngine {" -NewLines @(
                "const STORAGE_READY_WAIT_MS = 100;",
                "const DECRYPTION_RETRY_DELAY_MS = 2000;",
                "const PREMIUM_REFRESH_RETRY_DELAY_MS = 1000;",
                ""
            )
            Replace-Line -FilePath $sync -OldLine "        await new Promise(resolve => setTimeout(resolve, 100));" -NewLines @("        await new Promise(resolve => setTimeout(resolve, STORAGE_READY_WAIT_MS));")
            Replace-Line -FilePath $sync -OldLine "      }, 2000);" -NewLines @("      }, DECRYPTION_RETRY_DELAY_MS);")
            Replace-Line -FilePath $sync -OldLine "          await new Promise(resolve => setTimeout(resolve, 1000));" -NewLines @("          await new Promise(resolve => setTimeout(resolve, PREMIUM_REFRESH_RETRY_DELAY_MS));")

            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesBefore -FilePath $background -AnchorLine "let syncTimer = null;" -NewLines @("const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;")
            Replace-Text -FilePath $background -OldText "let syncInterval = 5 * 60 * 1000;" -NewText "let syncInterval = DEFAULT_SYNC_INTERVAL_MS;"
        }
        "7.7" {
            Replace-Line -FilePath (Get-StageFilePath $StageExtensionDir "popup\modules\utils.js") -OldLine "    this._events = {};" -NewLines @("    this._events = Object.create(null);")

            $dialog = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\dialog.js"
            Replace-Line -FilePath $dialog -OldLine "    this.overlay = document.getElementById('custom-dialog-overlay');" -NewLines @("    this.overlay = this.getElement('custom-dialog-overlay');")
            Replace-Line -FilePath $dialog -OldLine "    this.messageElement = document.getElementById('dialog-message');" -NewLines @("    this.messageElement = this.getElement('dialog-message');")
            Replace-Line -FilePath $dialog -OldLine "    this.confirmBtn = document.getElementById('dialog-confirm-btn');" -NewLines @("    this.confirmBtn = this.getElement('dialog-confirm-btn');")
            Replace-Line -FilePath $dialog -OldLine "    this.cancelBtn = document.getElementById('dialog-cancel-btn');" -NewLines @("    this.cancelBtn = this.getElement('dialog-cancel-btn');")
            Replace-Line -FilePath $dialog -OldLine "          const editor = document.getElementById('noteEditor');" -NewLines @("          const editor = this.getElement('noteEditor');")
            Insert-LinesBefore -FilePath $dialog -AnchorLine "  show(message) {" -NewLines @(
                "  getElement(id) {",
                "    return document.getElementById(id);",
                "  }",
                ""
            )
        }
        "7.8" {
            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Insert-LinesAfter -FilePath $content -AnchorLine "  'use strict';" -NewLines @(
                "",
                "  const SELECTION_SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED'];",
                "  const PARAGRAPH_TAGS = ['P', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'LI', 'TD', 'TH'];",
                "  const PARAGRAPH_CONTAINER_TAGS = ['DIV', 'SECTION'];",
                "  const PARAGRAPH_SKIP_TAGS = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'];",
                "  const PARAGRAPH_SKIP_CLASS_PATTERNS = ['sidebar', 'nav', 'menu', 'header', 'footer', 'toolbar', 'widget', 'ad', 'banner', 'popup', 'modal', 'infobox'];"
            )
            Replace-Line -FilePath $content -OldLine "            const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED'];" -NewLines @("            const skipTags = SELECTION_SKIP_TAGS;")
            Replace-Line -FilePath $content -OldLine "    const paragraphTags = ['P', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'LI', 'TD', 'TH'];" -NewLines @("    const paragraphTags = PARAGRAPH_TAGS;")
            Replace-Line -FilePath $content -OldLine "    const containerTags = ['DIV', 'SECTION']; " -NewLines @("    const containerTags = PARAGRAPH_CONTAINER_TAGS;")
            Replace-Line -FilePath $content -OldLine "    const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'NAV', 'HEADER', 'FOOTER', 'ASIDE'];" -NewLines @("    const skipTags = PARAGRAPH_SKIP_TAGS;")
            Replace-Line -FilePath $content -OldLine "    const skipClassPatterns = ['sidebar', 'nav', 'menu', 'header', 'footer', 'toolbar', 'widget', 'ad', 'banner', 'popup', 'modal', 'infobox'];" -NewLines @("    const skipClassPatterns = PARAGRAPH_SKIP_CLASS_PATTERNS;")
        }
        "7.9" {
            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Insert-LinesAfter -FilePath $content -AnchorLine "  let paragraphClickTimeout = null;" -NewLines @(
                "",
                "  function getHighlightCount() {",
                "    return highlights.length;",
                "  }"
            )
            Replace-Line -FilePath $content -OldLine "            highlightCount: highlights.length" -NewLines @("            highlightCount: getHighlightCount()")
            Replace-Line -FilePath $content -OldLine "    const count = highlights.length;" -NewLines @("    const count = getHighlightCount();") -ExpectedCount 2
            Replace-Line -FilePath $content -OldLine "    if (highlights.length === 0) {" -NewLines @("    if (getHighlightCount() === 0) {")
            Replace-Line -FilePath $content -OldLine "        text: highlights.length.toString()," -NewLines @("        text: getHighlightCount().toString(),")
        }
        "8.0" {
            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Insert-LinesBefore -FilePath $content -AnchorLine "  function getHighlightCount() {" -NewLines @(
                "  function createElement(tagName) {",
                "    return document.createElement(tagName);",
                "  }",
                ""
            )
            Replace-Text -FilePath $content -OldText "document.createElement('div')" -NewText "createElement('div')" -ExpectedCount 8
            Replace-Text -FilePath $content -OldText "document.createElement('button')" -NewText "createElement('button')" -ExpectedCount 3
            Replace-Text -FilePath $content -OldText "document.createElement('mark')" -NewText "createElement('mark')" -ExpectedCount 3
            Replace-Text -FilePath $content -OldText "document.createElement('style')" -NewText "createElement('style')" -ExpectedCount 5
        }
        "8.1" {
            $safeDom = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\safe-dom.js"
            Insert-LinesAfter -FilePath $safeDom -AnchorLine "class SafeDOM {" -NewLines @(
                "  static isAllowedAttribute(attribute, allowedAttributes) {",
                "    return allowedAttributes.includes(attribute);",
                "  }",
                ""
            )
            Replace-Line -FilePath $safeDom -OldLine "        if (safeAttributes.includes(key) && typeof value === 'string') {" -NewLines @("        if (SafeDOM.isAllowedAttribute(key, safeAttributes) && typeof value === 'string') {")

            $validator = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\input-validation.js"
            Insert-LinesAfter -FilePath $validator -AnchorLine "    constructor() {" -NewLines @(
                "        this.allowedProtocols = new Set(['http:', 'https:']);"
            )
            Replace-Line -FilePath $validator -OldLine "            if (!['http:', 'https:'].includes(urlObj.protocol)) {" -NewLines @("            if (!this.allowedProtocols.has(urlObj.protocol)) {")
        }
        "8.2" {
            $ads = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\ads.js"
            Insert-LinesBefore -FilePath $ads -AnchorLine "class AdManager {" -NewLines @(
                "const AD_HOUR_MS = 60 * 60 * 1000;",
                "const AD_COOLDOWN_MS = 12 * 60 * 1000;",
                "const AD_DISPLAY_DURATION_MS = 6 * 1000;",
                "const AD_NEXT_DELAY_MS = 30 * 1000;",
                "const AD_INITIAL_DELAY_MS = 3000;",
                "const AD_PREMIUM_CACHE_MS = 24 * 60 * 60 * 1000;",
                ""
            )
            Replace-Text -FilePath $ads -OldText "cooldownMs: 12 * 60 * 1000" -NewText "cooldownMs: AD_COOLDOWN_MS"
            Replace-Text -FilePath $ads -OldText "displayDurationMs: 6 * 1000" -NewText "displayDurationMs: AD_DISPLAY_DURATION_MS"
            Replace-Text -FilePath $ads -OldText "nextAdDelayMs: 30 * 1000" -NewText "nextAdDelayMs: AD_NEXT_DELAY_MS"
            Replace-Text -FilePath $ads -OldText "Date.now() + (60 * 60 * 1000)" -NewText "Date.now() + AD_HOUR_MS" -ExpectedCount 2
            Replace-Text -FilePath $ads -OldText "now + (60 * 60 * 1000)" -NewText "now + AD_HOUR_MS" -ExpectedCount 3
            Replace-Text -FilePath $ads -OldText "cacheAge < (24 * 60 * 60 * 1000)" -NewText "cacheAge < AD_PREMIUM_CACHE_MS"
            Replace-Text -FilePath $ads -OldText "setTimeout(() => this.showAd(), 3000)" -NewText "setTimeout(() => this.showAd(), AD_INITIAL_DELAY_MS)"
        }
        "8.3" {
            $ads = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\ads.js"
            Insert-LinesAfter -FilePath $ads -AnchorLine "    this.storageKey = 'adTrackingData';" -NewLines @("    this.adContentId = 'adContent';")
            Replace-Line -FilePath $ads -OldLine "    const adContent = document.getElementById('adContent');" -NewLines @("    const adContent = document.getElementById(this.adContentId);") -ExpectedCount 6

            $exportFormats = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\export-formats.js"
            Insert-LinesAfter -FilePath $exportFormats -AnchorLine "  constructor() {" -NewLines @(
                "    this.safeUrlProtocols = new Set(['http:', 'https:']);"
            )
            Replace-Line -FilePath $exportFormats -OldLine "      if (urlObj.protocol === 'http:' || urlObj.protocol === 'https:') {" -NewLines @("      if (this.safeUrlProtocols.has(urlObj.protocol)) {")
        }
        "8.4" {
            $popupStorage = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\storage.js"
            Insert-LinesBefore -FilePath $popupStorage -AnchorLine "  async loadNotes() {" -NewLines @(
                "  nowIso() {",
                "    return new Date().toISOString();",
                "  }",
                ""
            )
            Replace-Line -FilePath $popupStorage -OldLine "          exportedAt: new Date().toISOString()," -NewLines @("          exportedAt: this.nowIso(),")
            Replace-Line -FilePath $popupStorage -OldLine "              note.createdAt = new Date().toISOString();" -NewLines @("              note.createdAt = this.nowIso();")
            Replace-Line -FilePath $popupStorage -OldLine "            note.updatedAt = new Date().toISOString();" -NewLines @("            note.updatedAt = this.nowIso();")

            $notesStorage = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\storage.js"
            Insert-LinesAfter -FilePath $notesStorage -AnchorLine "    this.db = null;" -NewLines @("    this.versionRetentionLimit = 5;")
            Replace-Line -FilePath $notesStorage -OldLine "            const result = await this.maintainVersionHistory(note.id, 5);" -NewLines @("            const result = await this.maintainVersionHistory(note.id, this.versionRetentionLimit);")
        }
        "8.5" {
            $exportFormats = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\export-formats.js"
            Insert-LinesBefore -FilePath $exportFormats -AnchorLine "  convertContentForFormat(content, targetFormat) {" -NewLines @(
                "  ensureTagsArray(note) {",
                "    if (!Array.isArray(note.tags)) {",
                "      note.tags = [];",
                "    }",
                "    return note;",
                "  }",
                ""
            )
            Replace-Text -FilePath $exportFormats -OldText "    if (!Array.isArray(cleanNote.tags)) {
      cleanNote.tags = [];
    }
    return cleanNote;" -NewText "    return this.ensureTagsArray(cleanNote);"

            $popupStorage = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\storage.js"
            Insert-LinesBefore -FilePath $popupStorage -AnchorLine "  async exportNotes() {" -NewLines @(
                "  ensureTagsArray(note) {",
                "    if (!Array.isArray(note.tags)) {",
                "      note.tags = [];",
                "    }",
                "    return note;",
                "  }",
                ""
            )
            Replace-Text -FilePath $popupStorage -OldText "    if (!Array.isArray(cleanNote.tags)) {
      cleanNote.tags = [];
    }
    
    return cleanNote;" -NewText "    return this.ensureTagsArray(cleanNote);"
        }
        "8.6" {
            $settings = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\settings.js"
            Insert-LinesAfter -FilePath $settings -AnchorLine "    this.storageManager = storageManager;" -NewLines @("    this.allowedUrlProtocols = new Set(['http:', 'https:']);")
            Replace-Line -FilePath $settings -OldLine "      return ['http:', 'https:'].includes(urlObj.protocol);" -NewLines @("      return this.allowedUrlProtocols.has(urlObj.protocol);")

            $notes = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\notes.js"
            Insert-LinesBefore -FilePath $notes -AnchorLine "class NotesManager {" -NewLines @(
                "const NOTES_FREE_LIMIT = 50;",
                "const NOTES_LIMIT_WARNING_THRESHOLD = 0.8;",
                ""
            )
            Replace-Line -FilePath $notes -OldLine "      const FREE_NOTE_LIMIT = 50;" -NewLines @()
            Replace-Text -FilePath $notes -OldText "FREE_NOTE_LIMIT * 0.8" -NewText "NOTES_FREE_LIMIT * NOTES_LIMIT_WARNING_THRESHOLD"
            Replace-Text -FilePath $notes -OldText "FREE_NOTE_LIMIT" -NewText "NOTES_FREE_LIMIT" -ExpectedCount 2
        }
        "8.7" {
            $api = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\api.js"
            Insert-LinesBefore -FilePath $api -AnchorLine "class SupabaseClient {" -NewLines @(
                "const DEFAULT_SUPABASE_URL = 'https://kqjcorjjvunmyrnzvqgr.supabase.co';",
                "const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxamNvcmpqdnVubXlybnp2cWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MTc4ODgsImV4cCI6MjA3MTI5Mzg4OH0.l-ZdPOYMNi8x3lBqlemwQ2elDyvoPy-2ZUWuODVviWk';",
                ""
            )
            Replace-Line -FilePath $api -OldLine "    this.supabaseUrl = 'https://kqjcorjjvunmyrnzvqgr.supabase.co'; // Set from user-provided project URL" -NewLines @("    this.supabaseUrl = DEFAULT_SUPABASE_URL;")
            Replace-Line -FilePath $api -OldLine "    this.supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxamNvcmpqdnVubXlybnp2cWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MTc4ODgsImV4cCI6MjA3MTI5Mzg4OH0.l-ZdPOYMNi8x3lBqlemwQ2elDyvoPy-2ZUWuODVviWk'; // Set from user-provided anon key" -NewLines @("    this.supabaseAnonKey = DEFAULT_SUPABASE_ANON_KEY;")
        }
        "8.8" {
            $api = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\api.js"
            Insert-LinesAfter -FilePath $api -AnchorLine "const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxamNvcmpqdnVubXlybnp2cWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MTc4ODgsImV4cCI6MjA3MTI5Mzg4OH0.l-ZdPOYMNi8x3lBqlemwQ2elDyvoPy-2ZUWuODVviWk';" -NewLines @(
                "const SESSION_REFRESH_WINDOW_MS = 60000;",
                "const REQUEST_TIMEOUT_MS = 10000;",
                "const REQUEST_MAX_RETRIES = 2;"
            )
            Replace-Line -FilePath $api -OldLine "        if (!expiresAt || (expiresAt - now) < 60000) {" -NewLines @("        if (!expiresAt || (expiresAt - now) < SESSION_REFRESH_WINDOW_MS) {")
            Replace-Line -FilePath $api -OldLine "    timeoutMs = 10000," -NewLines @("    timeoutMs = REQUEST_TIMEOUT_MS,")
            Replace-Line -FilePath $api -OldLine "    maxRetries = 2," -NewLines @("    maxRetries = REQUEST_MAX_RETRIES,")
        }
        "8.9" {
            $settings = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\settings.js"
            Insert-LinesBefore -FilePath $settings -AnchorLine "class SettingsManager {" -NewLines @(
                "const BACKUP_REMINDER_PERIOD_MINUTES = 60 * 24 * 30;",
                "const BACKUP_REMINDER_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;",
                "const BACKUP_INSTALL_GRACE_MS = 7 * 24 * 60 * 60 * 1000;",
                ""
            )
            Replace-Line -FilePath $settings -OldLine "        delayInMinutes: 60 * 24 * 30," -NewLines @("        delayInMinutes: BACKUP_REMINDER_PERIOD_MINUTES,")
            Replace-Line -FilePath $settings -OldLine "        periodInMinutes: 60 * 24 * 30" -NewLines @("        periodInMinutes: BACKUP_REMINDER_PERIOD_MINUTES")
            Replace-Line -FilePath $settings -OldLine "      const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000);" -NewLines @("      const thirtyDaysAgo = now - BACKUP_REMINDER_INTERVAL_MS;")
            Replace-Line -FilePath $settings -OldLine "        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);" -NewLines @("        const sevenDaysAgo = now - BACKUP_INSTALL_GRACE_MS;")
        }
        "9.0" {
            $engagement = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\user-engagement.js"
            Insert-LinesBefore -FilePath $engagement -AnchorLine "class UserEngagement {" -NewLines @(
                "const REVIEW_EXTENSION_URL = 'https://chromewebstore.google.com/detail/anchored-%E2%80%93-notes-highligh/llkmfidpbpfgdgjlohgpomdjckcfkllg';",
                "const DEFERRED_PROMPT_DELAY_MS = 500;",
                "const REVIEW_PROMPT_ANIMATION_DELAY_MS = 100;",
                ""
            )
            Replace-Line -FilePath $engagement -OldLine "                }, 500);" -NewLines @("                }, DEFERRED_PROMPT_DELAY_MS);")
            Replace-Line -FilePath $engagement -OldLine "        }, 100);" -NewLines @("        }, REVIEW_PROMPT_ANIMATION_DELAY_MS);") -ExpectedCount 2
            Replace-Line -FilePath $engagement -OldLine "            const extensionUrl = 'https://chromewebstore.google.com/detail/anchored-%E2%80%93-notes-highligh/llkmfidpbpfgdgjlohgpomdjckcfkllg';" -NewLines @("            const extensionUrl = REVIEW_EXTENSION_URL;")
        }
        "9.1" {
            $encryption = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\encryption.js"
            Insert-LinesBefore -FilePath $encryption -AnchorLine "class NoteEncryption {" -NewLines @(
                "const PBKDF2_ITERATIONS = 100000;",
                "const SALT_BYTE_LENGTH = 32;",
                ""
            )
            Replace-Line -FilePath $encryption -OldLine "        iterations: 100000," -NewLines @("        iterations: PBKDF2_ITERATIONS,")
            Replace-Line -FilePath $encryption -OldLine "    const saltArray = crypto.getRandomValues(new Uint8Array(32));" -NewLines @("    const saltArray = crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));")
        }
        "9.2" {
            $onboarding = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\onboarding-tooltips.js"
            Insert-LinesAfter -FilePath $onboarding -AnchorLine "        this.storageKey = 'onboardingTooltipsShown';" -NewLines @(
                "        this.initialDelayMs = 1000;",
                "        this.svgNamespace = 'http://www.w3.org/2000/svg';"
            )
            Replace-Line -FilePath $onboarding -OldLine "        }, 1000);" -NewLines @("        }, this.initialDelayMs);")
            Replace-Text -FilePath $onboarding -OldText "document.createElementNS('http://www.w3.org/2000/svg'" -NewText "document.createElementNS(this.svgNamespace" -ExpectedCount 3
        }
        "9.3" {
            $onboarding = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\onboarding-tooltips.js"
            Insert-LinesBefore -FilePath $onboarding -AnchorLine "    async init() {" -NewLines @(
                "    createElement(tagName) {",
                "        return document.createElement(tagName);",
                "    }",
                ""
            )
            Replace-Text -FilePath $onboarding -OldText "document.createElement('div')" -NewText "this.createElement('div')" -ExpectedCount 7
            Replace-Text -FilePath $onboarding -OldText "document.createElement('button')" -NewText "this.createElement('button')" -ExpectedCount 3
            Replace-Text -FilePath $onboarding -OldText "document.createElement('h4')" -NewText "this.createElement('h4')"
            Replace-Text -FilePath $onboarding -OldText "document.createElement('p')" -NewText "this.createElement('p')"
            Replace-Text -FilePath $onboarding -OldText "document.createElement('span')" -NewText "this.createElement('span')"
        }
        "9.4" {
            $api = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\api.js"
            Insert-LinesBefore -FilePath $api -AnchorLine "  async _sleep(ms) {" -NewLines @(
                "  parseResponseBody(text) {",
                "    try { return text ? JSON.parse(text) : null; } catch (_) { return text; }",
                "  }",
                ""
            )
            Replace-Line -FilePath $api -OldLine "        try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }" -NewLines @("        data = this.parseResponseBody(text);")

            $sync = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\sync.js"
            Replace-Line -FilePath $sync -OldLine "      const formattedDeletions = unsyncedDeletions.map(deletion => ({" -NewLines @("      return unsyncedDeletions.map(deletion => ({")
            Replace-Line -FilePath $sync -OldLine "      return formattedDeletions;" -NewLines @()
        }
        "9.5" {
            $exportFormats = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\export-formats.js"
            Insert-LinesBefore -FilePath $exportFormats -AnchorLine "  toJSON(notesData) {" -NewLines @(
                "  formatExportDate() {",
                "    return new Date().toLocaleString();",
                "  }",
                ""
            )
            Replace-Line -FilePath $exportFormats -OldLine '    markdown += `*Exported on ${new Date().toLocaleString()}*\n\n`;' -NewLines @('    markdown += `*Exported on ${this.formatExportDate()}*\n\n`;') -ExpectedCount 2
        }
        "9.6" {
            $safeDom = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\safe-dom.js"
            Insert-LinesBefore -FilePath $safeDom -AnchorLine "  setContent(element, content, contentType = 'text') {" -NewLines @(
                "  normalizeContentType(contentType) {",
                "    return contentType || 'text';",
                "  }",
                ""
            )
            Replace-Line -FilePath $safeDom -OldLine "    switch (contentType) {" -NewLines @("    switch (this.normalizeContentType(contentType)) {")

            $premium = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\premium.js"
            Replace-Text -FilePath $premium -OldText "async function getPremiumStatus() {
  return {
    isPremium: await isPremiumUser(),
  };
}" -NewText "async function getPremiumStatus() {
  const isPremium = await isPremiumUser();
  return {
    isPremium,
  };
}"
        }
        "9.7" {
            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Insert-LinesBefore -FilePath $content -AnchorLine "  function updateExtensionBadge() {" -NewLines @(
                "  function getBadgeText() {",
                "    return getHighlightCount().toString();",
                "  }",
                ""
            )
            Replace-Line -FilePath $content -OldLine "        text: getHighlightCount().toString()," -NewLines @("        text: getBadgeText(),")

            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesBefore -FilePath $background -AnchorLine "function updateExtensionBadge(text, color) {" -NewLines @(
                "function getBadgeText(text) {",
                "  return text || '';",
                "}",
                ""
            )
            Replace-Line -FilePath $background -OldLine "      chrome.action.setBadgeText({ text: text || '' });" -NewLines @("      chrome.action.setBadgeText({ text: getBadgeText(text) });")
        }
        "9.8" {
            $settings = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\settings.js"
            Insert-LinesBefore -FilePath $settings -AnchorLine "  async checkBackupReminder() {" -NewLines @(
                "  getActiveNotes(notes) {",
                "    return notes.filter(note => !note.is_deleted);",
                "  }",
                ""
            )
            Replace-Line -FilePath $settings -OldLine "      const activeNotes = notes.filter(note => !note.is_deleted);" -NewLines @("      const activeNotes = this.getActiveNotes(notes);") -ExpectedCount 2
        }
        "9.9" {
            $api = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\api.js"
            Insert-LinesBefore -FilePath $api -AnchorLine "  getHeaders(includeAuth = true) {" -NewLines @(
                "  updateServiceUrls() {",
                '    this.apiUrl = `${this.supabaseUrl}/rest/v1`;',
                '    this.authUrl = `${this.supabaseUrl}/auth/v1`;',
                "  }",
                ""
            )
            Replace-Line -FilePath $api -OldLine '          this.apiUrl = `${this.supabaseUrl}/rest/v1`;' -NewLines @("          this.updateServiceUrls();")
            Replace-Line -FilePath $api -OldLine '          this.authUrl = `${this.supabaseUrl}/auth/v1`;' -NewLines @()
        }
        "10.0" {
            $config = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\config.js"
            Replace-Text -FilePath $config -OldText "  const DEFAULTS = {
    supabaseUrl: 'https://kqjcorjjvunmyrnzvqgr.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxamNvcmpqdnVubXlybnp2cWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MTc4ODgsImV4cCI6MjA3MTI5Mzg4OH0.l-ZdPOYMNi8x3lBqlemwQ2elDyvoPy-2ZUWuODVviWk'
  };" -NewText "  const DEFAULTS = Object.freeze({
    supabaseUrl: 'https://kqjcorjjvunmyrnzvqgr.supabase.co',
    supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxamNvcmpqdnVubXlybnp2cWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MTc4ODgsImV4cCI6MjA3MTI5Mzg4OH0.l-ZdPOYMNi8x3lBqlemwQ2elDyvoPy-2ZUWuODVviWk'
  });"

            $utils = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\utils.js"
            Insert-LinesBefore -FilePath $utils -AnchorLine "  static formatFileSize(bytes) {" -NewLines @(
                "  static getFileSizeUnits() {",
                "    return ['Bytes', 'KB', 'MB', 'GB'];",
                "  }",
                ""
            )
            Replace-Line -FilePath $utils -OldLine "    const sizes = ['Bytes', 'KB', 'MB', 'GB'];" -NewLines @("    const sizes = Utils.getFileSizeUnits();")
        }
        "10.1" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "lib\encryption.js",
                "lib\config.js",
                "assets\create-icons.html"
            ) -Pattern '^\s*//'
        }
        "10.2" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "lib\input-validation.js",
                "lib\xss-prevention.js"
            ) -Pattern '^\s*(/\*\*|\*|\*/)'
        }
        "10.3" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\modules\dialog.js",
                "popup\modules\editor.js",
                "popup\modules\storage.js"
            ) -Pattern '^\s*(/\*\*|\*|\*/)'
        }
        "10.4" {
            Remove-FullLineMatchesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "content\content.js",
                "popup\modules\onboarding-tooltips.js",
                "popup\css\variables.css",
                "popup\css\themes.css"
            ) -Pattern '^\s*/\*.*\*/\s*$'
        }
        "10.5" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "lib\encryption.js",
                "lib\config.js",
                "assets\create-icons.html",
                "lib\input-validation.js",
                "lib\xss-prevention.js"
            )
        }
        "10.6" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\modules\dialog.js",
                "popup\modules\editor.js",
                "popup\modules\storage.js",
                "content\content.js"
            )
        }
        "10.7" {
            $ads = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\ads.js"
            Insert-LinesBefore -FilePath $ads -AnchorLine "  async loadAdTrackingData() {" -NewLines @(
                "  getElementById(id) {",
                "    return document.getElementById(id);",
                "  }",
                ""
            )
            Replace-Line -FilePath $ads -OldLine "    this.adContainer = document.getElementById('adContainer');" -NewLines @("    this.adContainer = this.getElementById('adContainer');")
            Replace-Text -FilePath $ads -OldText "document.getElementById(this.adContentId)" -NewText "this.getElementById(this.adContentId)" -ExpectedCount 6
            Replace-Line -FilePath $ads -OldLine "    const nordvpnAd = document.getElementById('nordvpnAdBanner');" -NewLines @("    const nordvpnAd = this.getElementById('nordvpnAdBanner');")
            Replace-Line -FilePath $ads -OldLine "    const vrboAd = document.getElementById('vrboAdBanner');" -NewLines @("    const vrboAd = this.getElementById('vrboAdBanner');")
            Replace-Line -FilePath $ads -OldLine "    const newBannerAd = document.getElementById('newBannerAdBanner');" -NewLines @("    const newBannerAd = this.getElementById('newBannerAdBanner');")
            Replace-Line -FilePath $ads -OldLine "    const upgradeBtn = document.getElementById('upgradeAdButton');" -NewLines @("    const upgradeBtn = this.getElementById('upgradeAdButton');")
        }
        "10.8" {
            $ads = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\ads.js"
            Insert-LinesBefore -FilePath $ads -AnchorLine "  async loadAdTrackingData() {" -NewLines @(
                "  createElement(tagName) {",
                "    return document.createElement(tagName);",
                "  }",
                ""
            )
            Replace-Text -FilePath $ads -OldText "document.createElement('div')" -NewText "this.createElement('div')" -ExpectedCount 5
            Replace-Text -FilePath $ads -OldText "document.createElement('img')" -NewText "this.createElement('img')" -ExpectedCount 3
            Replace-Text -FilePath $ads -OldText "document.createElement('style')" -NewText "this.createElement('style')" -ExpectedCount 4
            Replace-Line -FilePath $ads -OldLine "    const strong = document.createElement('strong');" -NewLines @("    const strong = this.createElement('strong');")
            Replace-Line -FilePath $ads -OldLine "    const p = document.createElement('p');" -NewLines @("    const p = this.createElement('p');")
            Replace-Line -FilePath $ads -OldLine "    const button = document.createElement('button');" -NewLines @("    const button = this.createElement('button');")
        }
        "10.9" {
            $ads = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\ads.js"
            Insert-LinesBefore -FilePath $ads -AnchorLine "  async loadAdTrackingData() {" -NewLines @(
                "  isPremiumTier(tier) {",
                "    return tier === 'premium' || tier === 'pro';",
                "  }",
                ""
            )
            Replace-Line -FilePath $ads -OldLine "          isPremium = result.premiumStatus.tier === 'premium' || result.premiumStatus.tier === 'pro';" -NewLines @("          isPremium = this.isPremiumTier(result.premiumStatus.tier);")
            Replace-Line -FilePath $ads -OldLine "        isPremium = userTier === 'premium' || userTier === 'pro';" -NewLines @("        isPremium = this.isPremiumTier(userTier);")
        }
        "11.0" {
            $ads = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\ads.js"
            Insert-LinesAfter -FilePath $ads -AnchorLine "    this.adContentId = 'adContent';" -NewLines @(
                "    this.upgradeAdThreshold = 0.50;",
                "    this.nordvpnAdThreshold = 0.667;",
                "    this.vrboAdThreshold = 0.834;"
            )
            Replace-Line -FilePath $ads -OldLine "    if (random < 0.50) {" -NewLines @("    if (random < this.upgradeAdThreshold) {")
            Replace-Line -FilePath $ads -OldLine "    } else if (random < 0.667) {" -NewLines @("    } else if (random < this.nordvpnAdThreshold) {")
            Replace-Line -FilePath $ads -OldLine "    } else if (random < 0.834) {" -NewLines @("    } else if (random < this.vrboAdThreshold) {")
        }
        "11.1" {
            $ads = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\ads.js"
            Insert-LinesBefore -FilePath $ads -AnchorLine "  async loadAdTrackingData() {" -NewLines @(
                "  getRandomAdRoll() {",
                "    return Math.random();",
                "  }",
                ""
            )
            Replace-Line -FilePath $ads -OldLine "    const random = Math.random();" -NewLines @("    const random = this.getRandomAdRoll();")
        }
        "11.2" {
            $utils = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\utils.js"
            Insert-LinesBefore -FilePath $utils -AnchorLine "  static generateId() {" -NewLines @(
                "  static createElement(tagName) {",
                "    return document.createElement(tagName);",
                "  }",
                ""
            )
            Replace-Text -FilePath $utils -OldText "document.createElement('div')" -NewText "Utils.createElement('div')" -ExpectedCount 2
        }
        "11.3" {
            $utils = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\utils.js"
            Insert-LinesBefore -FilePath $utils -AnchorLine "  static generateId() {" -NewLines @(
                "  static getElementById(id) {",
                "    return document.getElementById(id);",
                "  }",
                ""
            )
            Replace-Line -FilePath $utils -OldLine "    const toast = document.getElementById('toast');" -NewLines @("    const toast = Utils.getElementById('toast');")
            Replace-Line -FilePath $utils -OldLine "    const storageBar = document.getElementById('storageUsageBar');" -NewLines @("    const storageBar = Utils.getElementById('storageUsageBar');")
            Replace-Line -FilePath $utils -OldLine "    const storageText = document.getElementById('storageUsageText');" -NewLines @("    const storageText = Utils.getElementById('storageUsageText');")
        }
        "11.4" {
            $utils = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\utils.js"
            Insert-LinesBefore -FilePath $utils -AnchorLine "  static showToast(message, type = 'info') {" -NewLines @(
                "  static getToastHideDelay(message) {",
                "    return message.toLowerCase().includes('sync') ? 2500 : 2000;",
                "  }",
                ""
            )
            Replace-Line -FilePath $utils -OldLine "    const hideDelay = message.toLowerCase().includes('sync') ? 2500 : 2000;" -NewLines @("    const hideDelay = Utils.getToastHideDelay(message);")
        }
        "11.5" {
            $utils = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\utils.js"
            Insert-LinesBefore -FilePath $utils -AnchorLine "  static formatFileSize(bytes) {" -NewLines @(
                "  static getFileSizeBase() {",
                "    return 1024;",
                "  }",
                ""
            )
            Replace-Line -FilePath $utils -OldLine "    const k = 1024;" -NewLines @("    const k = Utils.getFileSizeBase();")
        }
        "11.6" {
            $utils = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\utils.js"
            Insert-LinesBefore -FilePath $utils -AnchorLine "  static async retry(fn, maxAttempts = 3, baseDelay = 1000) {" -NewLines @(
                "  static getRetryDelay(baseDelay, attempt) {",
                "    return baseDelay * Math.pow(2, attempt - 1);",
                "  }",
                ""
            )
            Replace-Line -FilePath $utils -OldLine "        const delay = baseDelay * Math.pow(2, attempt - 1);" -NewLines @("        const delay = Utils.getRetryDelay(baseDelay, attempt);")
        }
        "11.7" {
            $api = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\api.js"
            Insert-LinesAfter -FilePath $api -AnchorLine "const REQUEST_MAX_RETRIES = 2;" -NewLines @(
                "const PROFILE_REFRESH_INTERVAL_MS = 60 * 60 * 1000;",
                "const REQUEST_RETRY_BASE_DELAY_MS = 2000;",
                "const REQUEST_RETRY_MAX_DELAY_MS = 8000;"
            )
            Replace-Line -FilePath $api -OldLine "            const oneHour = 60 * 60 * 1000; " -NewLines @("            const oneHour = PROFILE_REFRESH_INTERVAL_MS;")
            Replace-Line -FilePath $api -OldLine "    const oneHour = 60 * 60 * 1000; " -NewLines @("    const oneHour = PROFILE_REFRESH_INTERVAL_MS;")
        }
        "11.8" {
            $api = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\api.js"
            Insert-LinesBefore -FilePath $api -AnchorLine "  async _sleep(ms) {" -NewLines @(
                "  getRequestBackoff(attempt) {",
                "    return Math.min(REQUEST_RETRY_BASE_DELAY_MS * Math.pow(2, attempt), REQUEST_RETRY_MAX_DELAY_MS);",
                "  }",
                ""
            )
            Replace-Line -FilePath $api -OldLine "          const backoff = Math.min(2000 * Math.pow(2, attempt), 8000);" -NewLines @("          const backoff = this.getRequestBackoff(attempt);") -ExpectedCount 2
        }
        "11.9" {
            $api = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\api.js"
            Replace-Text -FilePath $api -OldText "new Date().toISOString()" -NewText "this.nowIso()" -ExpectedCount 4
            Insert-LinesBefore -FilePath $api -AnchorLine "  updateServiceUrls() {" -NewLines @(
                "  nowIso() {",
                "    return new Date().toISOString();",
                "  }",
                ""
            )
        }
        "12.0" {
            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesBefore -FilePath $background -AnchorLine "function getStoredNoteKey(noteId) {" -NewLines @(
                "function isHttpUrl(url) {",
                "  return !!url && url.startsWith(HTTP_URL_PREFIX);",
                "}",
                ""
            )
            Replace-Line -FilePath $background -OldLine "  if (!pageUrl || !pageUrl.startsWith(HTTP_URL_PREFIX)) {" -NewLines @("  if (!isHttpUrl(pageUrl)) {") -ExpectedCount 2
            Replace-Line -FilePath $background -OldLine "  if (!url || !url.startsWith(HTTP_URL_PREFIX)) {" -NewLines @("  if (!isHttpUrl(url)) {")
            Replace-Line -FilePath $background -OldLine "  if (!tab || !tab.url || !tab.url.startsWith(HTTP_URL_PREFIX)) {" -NewLines @("  if (!tab || !isHttpUrl(tab.url)) {")
        }
        "12.1" {
            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesAfter -FilePath $background -AnchorLine "const NOTE_LIMIT_REACHED_MESSAGE = 'You\'ve reached the 50 note limit on the free plan. Upgrade to Premium for unlimited notes!';" -NewLines @("const SESSION_INFO_MAX_AGE_MS = 60 * 60 * 1000;")
            Replace-Line -FilePath $background -OldLine "    const oneHourAgo = now - (60 * 60 * 1000);" -NewLines @("    const oneHourAgo = now - SESSION_INFO_MAX_AGE_MS;")
        }
        "12.2" {
            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesBefore -FilePath $background -AnchorLine "async function checkNoteLimitBeforeCreate() {" -NewLines @(
                "function getGeneratedNoteId() {",
                '  return crypto.randomUUID ? crypto.randomUUID() : `note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;',
                "}",
                ""
            )
            Replace-Line -FilePath $background -OldLine '    id: crypto.randomUUID ? crypto.randomUUID() : `note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,' -NewLines @("    id: getGeneratedNoteId(),") -ExpectedCount 2
        }
        "12.3" {
            $background = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "background\background.js"
            Insert-LinesBefore -FilePath $background -AnchorLine "async function toggleMultiHighlightModeFromContextMenu(tab) {" -NewLines @(
                "function getContentScriptRetryDelay(attempt) {",
                "  return 300 * attempt;",
                "}",
                ""
            )
            Replace-Line -FilePath $background -OldLine "            await new Promise(resolve => setTimeout(resolve, 300 * attempt)); // Progressive delay" -NewLines @("            await new Promise(resolve => setTimeout(resolve, getContentScriptRetryDelay(attempt)));")
        }
        "12.4" {
            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Replace-Text -FilePath $content -OldText "document.getElementById(" -NewText "getElementById(" -ExpectedCount 9
            Insert-LinesBefore -FilePath $content -AnchorLine "  function getHighlightCount() {" -NewLines @(
                "  function getElementById(id) {",
                "    return document.getElementById(id);",
                "  }",
                ""
            )
        }
        "12.5" {
            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Insert-LinesBefore -FilePath $content -AnchorLine "  function getHighlightCount() {" -NewLines @(
                "  function createHighlightId() {",
                "    return Date.now() + Math.random();",
                "  }",
                ""
            )
            Replace-Line -FilePath $content -OldLine "      id: Date.now() + Math.random()," -NewLines @("      id: createHighlightId(),")
        }
        "12.6" {
            $content = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "content\content.js"
            Insert-LinesAfter -FilePath $content -AnchorLine "  const PARAGRAPH_SKIP_CLASS_PATTERNS = ['sidebar', 'nav', 'menu', 'header', 'footer', 'toolbar', 'widget', 'ad', 'banner', 'popup', 'modal', 'infobox'];" -NewLines @(
                "  const PARAGRAPH_CLICK_RESET_MS = 200;",
                "  const HIGHLIGHT_REMOVE_DELAY_MS = 300;",
                "  const BADGE_MESSAGE_TIMEOUT_MS = 5000;"
            )
            Replace-Line -FilePath $content -OldLine "    }, 200);" -NewLines @("    }, PARAGRAPH_CLICK_RESET_MS);")
            Replace-Line -FilePath $content -OldLine "        }, 300); " -NewLines @("        }, HIGHLIGHT_REMOVE_DELAY_MS);")
            Replace-Line -FilePath $content -OldLine "      }, 5000);" -NewLines @("      }, BADGE_MESSAGE_TIMEOUT_MS);")
        }
        "12.7" {
            $popupStorage = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\storage.js"
            Insert-LinesBefore -FilePath $popupStorage -AnchorLine "  async loadNotes() {" -NewLines @(
                "  findNoteIndex(notes, noteId) {",
                "    return notes.findIndex(n => n.id === noteId);",
                "  }",
                ""
            )
            Replace-Line -FilePath $popupStorage -OldLine "    const noteIndex = notesForDomain.findIndex(n => n.id === note.id);" -NewLines @("    const noteIndex = this.findNoteIndex(notesForDomain, note.id);")
            Replace-Line -FilePath $popupStorage -OldLine "    const masterIndex = this.allNotes.findIndex(n => n.id === note.id);" -NewLines @("    const masterIndex = this.findNoteIndex(this.allNotes, note.id);")
        }
        "12.8" {
            $popupStorage = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\storage.js"
            Insert-LinesBefore -FilePath $popupStorage -AnchorLine "  async importNotes(importedData) {" -NewLines @(
                "  isReservedImportKey(domain) {",
                "    return domain === '_anchored' || domain === 'themeMode';",
                "  }",
                ""
            )
            Replace-Line -FilePath $popupStorage -OldLine "        if (domain === '_anchored' || domain === 'themeMode' || !Array.isArray(importedData[domain])) continue;" -NewLines @("        if (this.isReservedImportKey(domain) || !Array.isArray(importedData[domain])) continue;")
        }
        "12.9" {
            $popupStorage = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\storage.js"
            Insert-LinesBefore -FilePath $popupStorage -AnchorLine "  async clearAllEditorDrafts() {" -NewLines @(
                "  isDraftStorageKey(key) {",
                "    return key.includes('draft') || key.includes('editor');",
                "  }",
                ""
            )
            Replace-Text -FilePath $popupStorage -OldText "      const draftKeys = Object.keys(keys).filter(key =>
        key.includes('draft') || key.includes('editor')
      );" -NewText "      const draftKeys = Object.keys(keys).filter(key => this.isDraftStorageKey(key));"
        }
        "13.0" {
            $notes = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\notes.js"
            Replace-Text -FilePath $notes -OldText "document.getElementById(" -NewText "this.getElementById(" -ExpectedCount 8
            Insert-LinesBefore -FilePath $notes -AnchorLine "  async render() {" -NewLines @(
                "  getElementById(id) {",
                "    return document.getElementById(id);",
                "  }",
                ""
            )
        }
        "13.1" {
            $notes = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\notes.js"
            Insert-LinesBefore -FilePath $notes -AnchorLine "  async render() {" -NewLines @(
                "  createElement(tagName) {",
                "    return document.createElement(tagName);",
                "  }",
                ""
            )
            Replace-Text -FilePath $notes -OldText "document.createElement('details')" -NewText "this.createElement('details')"
            Replace-Text -FilePath $notes -OldText "document.createElement('div')" -NewText "this.createElement('div')" -ExpectedCount 3
        }
        "13.2" {
            $notes = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\notes.js"
            Insert-LinesBefore -FilePath $notes -AnchorLine "  async render() {" -NewLines @(
                "  nowIso() {",
                "    return new Date().toISOString();",
                "  }",
                ""
            )
            Replace-Line -FilePath $notes -OldLine "        draftTimestamp: new Date().toISOString()" -NewLines @("        draftTimestamp: this.nowIso()")
        }
        "13.3" {
            $editor = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\editor.js"
            Replace-Text -FilePath $editor -OldText "new Date().toISOString()" -NewText "this.nowIso()" -ExpectedCount 6
            Insert-LinesBefore -FilePath $editor -AnchorLine "  createNewNote(currentSite) {" -NewLines @(
                "  nowIso() {",
                "    return new Date().toISOString();",
                "  }",
                ""
            )
        }
        "13.4" {
            $editor = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\editor.js"
            Collapse-BlankLines -FilePath $editor
        }
        "13.5" {
            $settings = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\settings.js"
            Insert-LinesBefore -FilePath $settings -AnchorLine "  setButtonHTML(button, html) {" -NewLines @(
                "  getElementById(id) {",
                "    return document.getElementById(id);",
                "  }",
                ""
            )
            Replace-Line -FilePath $settings -OldLine "      const actions = document.getElementById('authActions');" -NewLines @("      const actions = this.getElementById('authActions');")
            Replace-Line -FilePath $settings -OldLine "      const syncManagement = document.getElementById('syncManagement');" -NewLines @("      const syncManagement = this.getElementById('syncManagement');")
        }
        "13.6" {
            $exportFormats = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\export-formats.js"
            Replace-Text -FilePath $exportFormats -OldText "new Date().toISOString()" -NewText "this.nowIso()" -ExpectedCount 3
            Insert-LinesAfter -FilePath $exportFormats -AnchorLine "  constructor() {" -NewLines @(
                "    this.createdAtFormatter = () => new Date().toISOString();"
            )
            Insert-LinesBefore -FilePath $exportFormats -AnchorLine "  cleanNoteData(note) {" -NewLines @(
                "  nowIso() {",
                "    return this.createdAtFormatter();",
                "  }",
                ""
            )
        }
        "13.7" {
            $exportFormats = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\export-formats.js"
            Insert-LinesBefore -FilePath $exportFormats -AnchorLine "  cleanNoteData(note) {" -NewLines @(
                "  createElement(tagName) {",
                "    return document.createElement(tagName);",
                "  }",
                ""
            )
            Replace-Text -FilePath $exportFormats -OldText "document.createElement('div')" -NewText "this.createElement('div')" -ExpectedCount 2
        }
        "13.8" {
            $exportFormats = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "popup\modules\export-formats.js"
            Insert-LinesBefore -FilePath $exportFormats -AnchorLine "  cleanNoteData(note) {" -NewLines @(
                "  countDomains(notesData) {",
                "    return Object.keys(notesData).filter(key => key !== '_anchored').length;",
                "  }",
                ""
            )
            Replace-Line -FilePath $exportFormats -OldLine "    const totalDomains = Object.keys(notesData).filter(key => key !== '_anchored').length;" -NewLines @("    const totalDomains = this.countDomains(notesData);") -ExpectedCount 3
        }
        "13.9" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\modules\notes.js",
                "popup\modules\editor.js",
                "popup\modules\settings.js",
                "popup\modules\export-formats.js"
            )
        }
        "14.0" {
            $safeDom = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\safe-dom.js"
            Insert-LinesAfter -FilePath $safeDom -AnchorLine "    this.xssPrevention = window.xssPrevention;" -NewLines @("    this.safeAttributes = ['class', 'id', 'title', 'href', 'target', 'rel'];")
            Replace-Line -FilePath $safeDom -OldLine "      const safeAttributes = ['class', 'id', 'title', 'href', 'target', 'rel'];" -NewLines @("      const safeAttributes = this.safeAttributes;")
        }
        "14.1" {
            $safeDom = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\safe-dom.js"
            Insert-LinesBefore -FilePath $safeDom -AnchorLine "  stripHTML(html) {" -NewLines @(
                "  createScratchElement() {",
                "    return document.createElement('div');",
                "  }",
                ""
            )
            Replace-Line -FilePath $safeDom -OldLine "    const temp = document.createElement('div');" -NewLines @("    const temp = this.createScratchElement();")
        }
        "14.2" {
            $xss = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\xss-prevention.js"
            Insert-LinesBefore -FilePath $xss -AnchorLine "  sanitizeRichText(html) {" -NewLines @(
                "  createElement(tagName) {",
                "    return document.createElement(tagName);",
                "  }",
                ""
            )
            Replace-Line -FilePath $xss -OldLine "    const temp = document.createElement('div');" -NewLines @("    const temp = this.createElement('div');") -ExpectedCount 2
            Replace-Line -FilePath $xss -OldLine "    const element = document.createElement(tagName);" -NewLines @("    const element = this.createElement(tagName);")
        }
        "14.3" {
            $sync = Get-StageFilePath -StageExtensionDir $StageExtensionDir -RelativePath "lib\sync.js"
            Insert-LinesBefore -FilePath $sync -AnchorLine "  async init() {" -NewLines @(
                "  sleep(ms) {",
                "    return new Promise(resolve => setTimeout(resolve, ms));",
                "  }",
                ""
            )
            Replace-Line -FilePath $sync -OldLine "        await new Promise(resolve => setTimeout(resolve, STORAGE_READY_WAIT_MS));" -NewLines @("        await this.sleep(STORAGE_READY_WAIT_MS);")
            Replace-Line -FilePath $sync -OldLine "          await new Promise(resolve => setTimeout(resolve, PREMIUM_REFRESH_RETRY_DELAY_MS));" -NewLines @("          await this.sleep(PREMIUM_REFRESH_RETRY_DELAY_MS);")
        }
        "14.4" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\popup.js",
                "popup\popup.html"
            )
        }
        "14.5" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\popup.css",
                "popup\dialog.css"
            )
        }
        "14.6" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\css\components.css",
                "popup\css\settings.css"
            )
        }
        "14.7" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\css\editor.css",
                "popup\css\animations.css"
            )
        }
        "14.8" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "popup\css\variables.css",
                "popup\css\themes.css"
            )
        }
        "14.9" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "lib\premium.js",
                "lib\safe-dom.js",
                "lib\sync.js"
            )
        }
        "15.0" {
            Collapse-BlankLinesFromFiles -BaseDirectory $StageExtensionDir -RelativePaths @(
                "lib\ads.js",
                "lib\api.js",
                "background\background.js",
                "manifest.json"
            )
        }
        default {
            throw "No cleanup step defined for version $Version"
        }
    }
}

$sourcePath = Join-Path (Get-Location) $SourceDir
$outputPath = Join-Path (Get-Location) $OutputDir

if (-not (Test-Path -LiteralPath $sourcePath)) {
    throw "Source directory not found: $sourcePath"
}

if (-not (Test-Path -LiteralPath $outputPath)) {
    New-Item -ItemType Directory -Path $outputPath | Out-Null
}

$versions = Get-VersionSequence -Start $StartVersion -End $EndVersion
$stageRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("anchored-versioned-zips-" + [System.Guid]::NewGuid().ToString("N"))

New-Item -ItemType Directory -Path $stageRoot | Out-Null

try {
    $baseStage = Join-Path $stageRoot "base"
    New-Item -ItemType Directory -Path $baseStage | Out-Null

    if ($BaselineZip) {
        if ([System.IO.Path]::IsPathRooted($BaselineZip)) {
            $baselineZipPath = $BaselineZip
        }
        else {
            $baselineZipPath = Join-Path (Get-Location) $BaselineZip
        }

        if (-not (Test-Path -LiteralPath $baselineZipPath)) {
            throw "Baseline zip not found: $baselineZipPath"
        }

        Expand-Archive -LiteralPath $baselineZipPath -DestinationPath $baseStage
    }
    else {
        Copy-Item -LiteralPath $sourcePath -Destination $baseStage -Recurse
    }

    $currentStage = Join-Path $baseStage "extension"

    if (-not (Test-Path -LiteralPath $currentStage)) {
        throw "Staged extension directory not found: $currentStage"
    }

    foreach ($version in $versions) {
        Apply-CleanupStep -StageExtensionDir $currentStage -Version $version
        Set-ManifestVersion -ManifestPath (Join-Path $currentStage "manifest.json") -Version $version

        $zipPath = Join-Path $outputPath "$version.zip"
        New-ZipFromDirectory -RootDirectory $currentStage -ZipPath $zipPath

        $relativeZipPath = Get-RelativePath -BasePath (Get-Location).Path -ChildPath $zipPath
        $zipSize = (Get-Item -LiteralPath $zipPath).Length
        Write-Output "$relativeZipPath`t$zipSize"
    }
}
finally {
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
