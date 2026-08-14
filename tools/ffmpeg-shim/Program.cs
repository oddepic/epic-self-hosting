using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

// Jellyfin ffmpeg shim.
//
// Jellyfin (<= 10.11.11) passes integer `-hls_time 3` and
// `-force_key_frames "expr:gte(t,n_forced*3)"` to ffmpeg. At fractional NTSC
// framerates (23.976/29.97) ffmpeg can only cut segments on whole frames, so it
// emits a mix of 72/71-frame segments while the HLS playlist advertises a
// uniform 3.003s — the browser's timeline drifts ahead of the media and
// client-rendered subtitles run progressively early (jellyfin#16730).
//
// This shim rewrites those two args to the frame-aligned float
// `ceil(N * fps) / fps` (3.003 for 23.976) and forwards everything else to the
// real ffmpeg. See docs/adr/ for the decision.
internal static class Program
{
    private const string RealFfmpeg = @"C:\Program Files\Jellyfin\Server\ffmpeg.exe";
    private const string RealFfprobe = @"C:\Program Files\Jellyfin\Server\ffprobe.exe";

    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const int JobObjectExtendedLimitInfoClass = 9;

    private static int Main()
    {
        var raw = Environment.CommandLine;
        var firstSpace = raw.IndexOf(' ');
        var args = firstSpace < 0 ? string.Empty : raw.Substring(firstSpace + 1).Trim();

        var aligned = ComputeAlignedSegmentLength(args);
        if (aligned != null)
        {
            args = Regex.Replace(args, @"\-hls_time\s+\d+", "-hls_time " + aligned);
            args = Regex.Replace(args, @"n_forced\*\d+", "n_forced*" + aligned);
        }

        var psi = new ProcessStartInfo();
        psi.FileName = RealFfmpeg;
        psi.Arguments = args;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;

        var proc = new Process();
        proc.StartInfo = psi;
        proc.Start();
        AssignToJob(proc);

        var copyOut = proc.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var copyErr = proc.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        var copyIn = Task.Run(() =>
        {
            try
            {
                if (Console.IsInputRedirected)
                {
                    Console.OpenStandardInput().CopyTo(proc.StandardInput.BaseStream);
                }
            }
            catch
            {
            }

            try
            {
                proc.StandardInput.Close();
            }
            catch
            {
            }
        });

        proc.WaitForExit();
        try { copyIn.Wait(1000); } catch { }
        try { copyOut.Wait(2000); } catch { }
        try { copyErr.Wait(2000); } catch { }
        return proc.ExitCode;
    }

    private static string ComputeAlignedSegmentLength(string args)
    {
        var segMatch = Regex.Match(args, @"\-hls_time\s+(\d+)");
        if (!segMatch.Success)
        {
            return null;
        }

        int segLen;
        if (!int.TryParse(segMatch.Groups[1].Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out segLen))
        {
            return null;
        }

        var input = ExtractInput(args);
        if (input == null)
        {
            return null;
        }

        var fps = ProbeFramerate(input);
        if (fps <= 0)
        {
            return null;
        }

        // Only fractional framerates need realignment; integer framerates
        // (24, 25, 30...) already divide evenly.
        if (Math.Abs(fps - Math.Floor(fps + 0.001)) <= 0.001)
        {
            return null;
        }

        var aligned = Math.Ceiling(segLen * fps) / fps;
        return aligned.ToString("0.######", CultureInfo.InvariantCulture);
    }

    private static string ExtractInput(string args)
    {
        var m = Regex.Match(args, @"\-i\s+(?:file:)?""([^""]+)""");
        if (m.Success)
        {
            return m.Groups[1].Value;
        }

        m = Regex.Match(args, @"\-i\s+(\S+)");
        return m.Success ? m.Groups[1].Value : null;
    }

    private static double ProbeFramerate(string input)
    {
        try
        {
            var psi = new ProcessStartInfo();
            psi.FileName = RealFfprobe;
            psi.Arguments = "-v error -select_streams v:0 -show_entries stream=avg_frame_rate -of default=noprint_wrappers=1:nokey=1 -i \"" + input + "\"";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            var proc = Process.Start(psi);
            var stdout = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();

            var m = Regex.Match(stdout, @"(\d+(?:\.\d+)?)\s*/\s*(\d+)");
            if (m.Success)
            {
                double num = double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                double den = double.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
                if (den > 0)
                {
                    return num / den;
                }
            }

            m = Regex.Match(stdout, @"(\d+(?:\.\d+)?)");
            if (m.Success)
            {
                return double.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            }
        }
        catch
        {
            // If probing fails, fall through and leave the args untouched.
        }

        return 0;
    }

    // Tie ffmpeg to this process's job object so that when Jellyfin kills the
    // shim (seek / stop), the transcoding ffmpeg is killed with it instead of
    // being orphaned and leaking disk.
    private static void AssignToJob(Process proc)
    {
        try
        {
            var job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero)
            {
                return;
            }

            var info = new JobObjectExtendedLimitInformation();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            var size = Marshal.SizeOf(typeof(JobObjectExtendedLimitInformation));
            var ptr = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, ptr, false);
                if (SetInformationJobObject(job, JobObjectExtendedLimitInfoClass, ptr, (uint)size))
                {
                    AssignProcessToJobObject(job, proc.Handle);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(ptr);
            }
        }
        catch
        {
            // Job object is a best-effort guard; never fail the transcode over it.
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int infoType, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
}
