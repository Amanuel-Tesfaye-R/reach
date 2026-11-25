param(
  [Parameter(Mandatory=$true)]
  [string]$OutPath
)

$ErrorActionPreference = 'Stop'

if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) {
  Write-Error "SCREEN_LOCKED: PC is currently on the Windows lock screen. Unlock the desktop to capture a screenshot."
  exit 2
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
public class ScreenCaptureService {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern IntPtr CreateCompatibleBitmap(IntPtr hDC, int nWidth, int nHeight);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll", SetLastError = true)] public static extern bool BitBlt(IntPtr hObject, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hObjectSource, int nXSrc, int nYSrc, int dwRop);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hDC);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);

    const uint DESKTOP_ALL = 0x01FF;

    public static string Capture(string outFile) {
        string error = null;
        Thread t = new Thread(() => {
            IntPtr hDesk = OpenDesktop("Default", 0, false, DESKTOP_ALL);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
            }

            int w = GetSystemMetrics(0); // SM_CXSCREEN
            int h = GetSystemMetrics(1); // SM_CYSCREEN
            if (w <= 0) w = 1920;
            if (h <= 0) h = 1080;

            IntPtr deskDC = GetDC(IntPtr.Zero);
            IntPtr memDC = CreateCompatibleDC(deskDC);
            IntPtr hBmp = CreateCompatibleBitmap(deskDC, w, h);
            IntPtr oldBmp = SelectObject(memDC, hBmp);

            bool bb = BitBlt(memDC, 0, 0, w, h, deskDC, 0, 0, 0x00CC0020);
            int bbErr = Marshal.GetLastWin32Error();

            SelectObject(memDC, oldBmp);
            DeleteDC(memDC);
            ReleaseDC(IntPtr.Zero, deskDC);
            if (hDesk != IntPtr.Zero) CloseDesktop(hDesk);

            if (!bb) {
                error = "BitBlt failed: " + bbErr;
                return;
            }

            using (Bitmap bmp = Image.FromHbitmap(hBmp)) {
                bmp.Save(outFile, ImageFormat.Png);
            }
            DeleteObject(hBmp);
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();

        if (error != null) throw new InvalidOperationException(error);
        return outFile;
    }
}
"@

[ScreenCaptureService]::Capture($OutPath) | Out-Null
Write-Output $OutPath
