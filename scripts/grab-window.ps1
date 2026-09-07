# Capture the app's own window to a PNG, in true physical pixels.
#
# The DOM is not the screen. Every check on this card so far has asked the
# renderer what it believes — the clip is decoding, the band is open — and she
# has never once seen either. That gap can only be closed by photographing
# what is actually on the glass.
#
# DPI-aware and driven by the window rectangle, for the reason mpv-smoke gives
# at length: her desks are mixed DPI, so any coordinate arithmetic done in the
# renderer's space samples a point on a different screen.
#
#   powershell -File scripts/grab-window.ps1 <pid> <out.png>

param([int]$TargetPid, [string]$Out)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NtvGrab {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int procId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
}
"@

[NtvGrab]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Drawing

# The BIGGEST visible top-level window belonging to the app: the pair presents
# as two windows and the interface plane is the one covering the picture.
$best = [System.IntPtr]::Zero
$bestArea = -1
$h = [System.IntPtr]::Zero
do {
  $h = [NtvGrab]::FindWindowEx([System.IntPtr]::Zero, $h, [NullString]::Value, [NullString]::Value)
  if ($h -ne [System.IntPtr]::Zero) {
    $owner = 0
    [NtvGrab]::GetWindowThreadProcessId($h, [ref]$owner) | Out-Null
    if ($owner -eq $TargetPid -and [NtvGrab]::IsWindowVisible($h)) {
      $r = New-Object NtvGrab+RECT
      [NtvGrab]::GetWindowRect($h, [ref]$r) | Out-Null
      $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
      if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
    }
  }
} while ($h -ne [System.IntPtr]::Zero)

if ($best -eq [System.IntPtr]::Zero) { Write-Output "NOWINDOW"; exit 1 }

$r = New-Object NtvGrab+RECT
[NtvGrab]::GetWindowRect($best, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("GRABBED {0}x{1} at {2},{3}" -f $w, $ht, $r.Left, $r.Top)
