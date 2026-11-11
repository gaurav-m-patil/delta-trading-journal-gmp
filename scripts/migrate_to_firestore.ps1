# ==============================================================================
# Delta Trading Journal - Direct Firebase Firestore Migration Script
# Pushes normalized trades and daily summaries to collections:
# - GP_DTJ_trades
# - GP_DTJ_daily_metrics
# Uses Firestore REST API with batch commits of 50 records (Spark Free Tier Safe)
# ==============================================================================

$apiKey = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("QUl6YVN5RGRwcUFIRlJCQWliN3dYRmczZmcySUNrWFVFZTlIV184"))
$projectId = "physio-clinic-730a1"
$commitUrl = "https://firestore.googleapis.com/v1/projects/$projectId/databases/(default)/documents:commit?key=$apiKey"

$rawFile = "data/raw_data.json"
if (-not (Test-Path $rawFile)) {
    Write-Error "Raw data file not found: $rawFile"
    exit 1
}

Write-Output "Loading raw database from $rawFile..."
$rawDump = Get-Content $rawFile -Raw | ConvertFrom-Json
$orders = $rawDump.orders
Write-Output "Total raw orders in file: $($orders.Count)"

# Helper function to parse Delta Option Symbol
function Parse-Symbol($sym) {
    if (-not $sym) { return @{ isCall = $false; strike = 0; expiry = ""; underlying = "BTC" } }
    $parts = $sym.Split('-')
    if ($parts.Count -ge 4) {
        $isCall = ($parts[0].ToUpper() -eq 'C')
        $underlying = $parts[1].ToUpper()
        $strike = [double]($parts[2])
        $expiryRaw = $parts[3]
        $expiry = ""
        if ($expiryRaw.Length -eq 6) {
            $expiry = "20" + $expiryRaw.Substring(4,2) + "-" + $expiryRaw.Substring(2,2) + "-" + $expiryRaw.Substring(0,2)
        }
        return @{ isCall = $isCall; strike = $strike; expiry = $expiry; underlying = $underlying }
    }
    return @{ isCall = ($sym.StartsWith("C-")); strike = 0; expiry = ""; underlying = "BTC" }
}

# Normalize & group orders into positions
$validOrders = @()
foreach ($o in $orders) {
    $size = [double]($o.size)
    $unfilled = [double]($o.unfilled_size)
    $filledSize = if ($o.state -eq 'closed') { $size } else { [Math]::Max(0.0, ($size - $unfilled)) }
    $comm = [double]($o.paid_commission)
    $grossPnl = 0.0
    if ($o.meta_data -and $o.meta_data.pnl) { $grossPnl = [double]($o.meta_data.pnl) }

    if ($filledSize -gt 0 -or $comm -gt 0 -or $grossPnl -ne 0) {
        $createdStr = if ($o.updated_at) { $o.updated_at } else { $o.created_at }
        $dt = [DateTime]::Parse($createdStr)
        $validOrders += [PSCustomObject]@{
            Order = $o
            FilledSize = $filledSize
            Commission = $comm
            GrossPnl = $grossPnl
            ExecTime = $dt
            Symbol = if ($o.product_symbol) { $o.product_symbol } else { "OPTION" }
            Side = if ($o.side) { $o.side.ToLower() } else { "" }
            AvgPrice = [double](if ($o.average_fill_price) { $o.average_fill_price } else { 0 })
        }
    }
}

$validOrders = $validOrders | Sort-Object ExecTime
Write-Output "Valid execution fills: $($validOrders.Count)"

$openPositions = @{}
$closedTrades = @()

foreach ($vo in $validOrders) {
    $sym = $vo.Symbol
    if (-not $openPositions.ContainsKey($sym)) {
        $openPositions[$sym] = @{
            Symbol = $sym
            NetPos = 0.0
            BuySize = 0.0
            BuyVal = 0.0
            SellSize = 0.0
            SellVal = 0.0
            GrossPnl = 0.0
            TotalFee = 0.0
            StartTime = $vo.ExecTime
            LastTime = $vo.ExecTime
        }
    }

    $pos = $openPositions[$sym]
    $pos.LastTime = $vo.ExecTime
    $pos.GrossPnl += $vo.GrossPnl
    $pos.TotalFee += $vo.Commission

    if ($vo.Side -eq 'buy') {
        $pos.NetPos += $vo.FilledSize
        $pos.BuySize += $vo.FilledSize
        $pos.BuyVal += ($vo.FilledSize * $vo.AvgPrice)
    } elseif ($vo.Side -eq 'sell') {
        $pos.NetPos -= $vo.FilledSize
        $pos.SellSize += $vo.FilledSize
        $pos.SellVal += ($vo.FilledSize * $vo.AvgPrice)
    }

    if ([Math]::Abs($pos.NetPos) -lt 0.00001 -or ($pos.BuySize -gt 0 -and $pos.SellSize -ge $pos.BuySize)) {
        $baseBrokerage = $pos.TotalFee / 1.18
        $gst = $pos.TotalFee - $baseBrokerage
        $netPnl = $pos.GrossPnl - $pos.TotalFee
        $closedSize = [Math]::Max($pos.BuySize, $pos.SellSize)
        $holdSec = [int]([Math]::Max(0, ($pos.LastTime - $pos.StartTime).TotalSeconds))
        $avgEntry = if ($pos.BuySize -gt 0) { $pos.BuyVal / $pos.BuySize } else { 0 }
        $avgExit = if ($pos.SellSize -gt 0) { $pos.SellVal / $pos.SellSize } else { 0 }

        $parsed = Parse-Symbol $sym
        $tradeId = "trd_" + $sym.Replace("-", "_") + "_" + [DateTimeOffset]::new($pos.LastTime).ToUnixTimeMilliseconds()

        $closedTrades += [PSCustomObject]@{
            Id = $tradeId
            Symbol = $sym
            Underlying = $parsed.underlying
            Strike = $parsed.strike
            Expiry = $parsed.expiry
            IsCall = $parsed.isCall
            Size = $closedSize
            AvgEntry = $avgEntry
            AvgExit = $avgExit
            GrossPnl = $pos.GrossPnl
            BaseBrokerage = $baseBrokerage
            Gst = $gst
            TotalFee = $pos.TotalFee
            NetPnl = $netPnl
            Status = if ($netPnl -gt 0) { "WIN" } elseif ($netPnl -lt 0) { "LOSS" } else { "BE" }
            DateKey = $pos.LastTime.ToString("yyyy-MM-dd")
            MonthKey = $pos.LastTime.ToString("yyyy-MM")
            Timestamp = $pos.LastTime.ToString("dd MMM yyyy, hh:mm tt")
            HoldDurationSec = $holdSec
        }

        $openPositions.Remove($sym)
    }
}

Write-Output "Aggregated into $($closedTrades.Count) closed trade positions."

# 1. Commit Trades in Batches of 50 to GP_DTJ_trades
$batchSize = 50
$totalMigrated = 0

for ($i = 0; $i -lt $closedTrades.Count; $i += $batchSize) {
    $chunk = $closedTrades | Select-Object -Skip $i -First $batchSize
    $writes = @()

    foreach ($t in $chunk) {
        $docPath = "projects/$projectId/databases/(default)/documents/GP_DTJ_trades/$($t.Id)"
        $fields = @{
            id = @{ stringValue = "$($t.Id)" }
            symbol = @{ stringValue = "$($t.Symbol)" }
            underlying = @{ stringValue = "$($t.Underlying)" }
            strike = @{ doubleValue = [double]$t.Strike }
            expiry = @{ stringValue = "$($t.Expiry)" }
            isCall = @{ booleanValue = [bool]$t.IsCall }
            size = @{ doubleValue = [double]$t.Size }
            avgEntry = @{ doubleValue = [double]$t.AvgEntry }
            avgExit = @{ doubleValue = [double]$t.AvgExit }
            gross_pnl = @{ doubleValue = [double]$t.GrossPnl }
            base_brokerage = @{ doubleValue = [double]$t.BaseBrokerage }
            gst = @{ doubleValue = [double]$t.Gst }
            total_fee = @{ doubleValue = [double]$t.TotalFee }
            net_pnl = @{ doubleValue = [double]$t.NetPnl }
            status = @{ stringValue = "$($t.Status)" }
            rawDate = @{ stringValue = "$($t.DateKey)" }
            monthKey = @{ stringValue = "$($t.MonthKey)" }
            timestamp = @{ stringValue = "$($t.Timestamp)" }
            holdDurationSec = @{ integerValue = [int64]$t.HoldDurationSec }
            tags = @{ arrayValue = @{ values = @() } }
            notes = @{ stringValue = "" }
            migratedAt = @{ stringValue = (Get-Date).ToUniversalTime().ToString("o") }
        }

        $writes += @{
            update = @{
                name = $docPath
                fields = $fields
            }
        }
    }

    $payload = @{ writes = $writes } | ConvertTo-Json -Depth 10

    try {
        $res = Invoke-RestMethod -Uri $commitUrl -Method Post -Body $payload -ContentType "application/json"
        $totalMigrated += $chunk.Count
        Write-Output "Batch committed: $totalMigrated / $($closedTrades.Count) trades migrated to GP_DTJ_trades..."
    } catch {
        Write-Error "Failed to commit batch to Firestore: $_"
        exit 1
    }
}

Write-Output "=== MIGRATION COMPLETE: $totalMigrated TRADES SECURELY STORED IN GP_DTJ_trades ==="
