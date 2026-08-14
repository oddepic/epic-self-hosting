using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

// Jellyfin ffmpeg shim.
//
// When Jellyfin restarts ffmpeg mid-video with `-ss` (resume / seek beyond the
// transcoded buffer), the demuxer seeks to the nearest source keyframe, which
// may be seconds before the target. Transcoded video is trimmed back to the
// target by `accurate_seek`, but stream-copied audio is not — so the audio
// content starts early and drifts against the video and the subtitles
// (jellyfin#14194, fixed upstream in 12.0 by PR #16580).
//
// This shim applies the same fix: a `noise` bitstream filter that drops copied
// audio packets with PTS before the seek target, so audio and video start at
// the same time. See docs/adr/ for the decision.
internal static class Program
{
    private const string RealFfmpeg = @"C:\Program Files\Jellyfin\Server\ffmpeg.exe";

    private const uint JobObjectLimitKillOnJobClose = 0x2000;
    private const int JobObjectExtendedLimitInfoClass = 9;

    private static int Main()
    {
        var raw = Environment.CommandLine;
        var firstSpace = raw.IndexOf(' ');
        var args = firstSpace < 0 ? string.Empty : raw.Substring(firstSpace + 1).Trim();

        args = AddAudioSeekTrim(args);

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

    private static string AddAudioSeekTrim(string args)
    {
        var match = Regex.Match(args, @"(?<=\-ss\s)(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)");
        if (!match.Success)
        {
            return args;
        }

        TimeSpan seek;
        if (!TimeSpan.TryParse(match.Value, CultureInfo.InvariantCulture, out seek))
        {
            return args;
        }

        var seconds = seek.TotalSeconds.ToString("0.###", CultureInfo.InvariantCulture);
        var bsf = "-bsf:a \"noise=drop=lt(pts*tb\\," + seconds + ")\"";

        var insertAt = match.Index + match.Length;
        return args.Substring(0, insertAt) + " " + bsf + args.Substring(insertAt);
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
