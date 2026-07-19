// MajSoulDaily windowless launcher.
// Accepts only "primary" or "catchup". Starts installed Node with no window.
// Contains no UI or synthetic input APIs.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class Program
{
    private const string MutexNamePrefix = "Local\\MajSoulDaily.Launcher.";

    private static int Main(string[] args)
    {
        if (args == null || args.Length != 1)
        {
            return 64;
        }

        string trigger = args[0].Trim().ToLowerInvariant();
        if (trigger != "primary" && trigger != "catchup")
        {
            return 64;
        }

        string baseDir;
        try
        {
            baseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar
            );
        }
        catch
        {
            return 2;
        }

        string nodePath = Path.Combine(baseDir, "node.exe");
        string runnerPath = Path.Combine(baseDir, "src", "cli", "run.mjs");
        if (!File.Exists(nodePath) || !File.Exists(runnerPath))
        {
            return 2;
        }

        bool createdNew;
        Mutex mutex = new Mutex(true, MutexNamePrefix + trigger, out createdNew);
        if (!createdNew)
        {
            mutex.Dispose();
            return 0;
        }

        try
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = nodePath;
            start.Arguments = "\"" + runnerPath + "\" --trigger " + trigger;
            start.WorkingDirectory = baseDir;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = false;
            start.RedirectStandardError = false;
            start.RedirectStandardInput = false;

            Process process = Process.Start(start);
            if (process == null)
            {
                return 2;
            }

            try
            {
                process.WaitForExit();
                return process.ExitCode;
            }
            finally
            {
                process.Dispose();
            }
        }
        catch
        {
            return 2;
        }
        finally
        {
            try
            {
                mutex.ReleaseMutex();
            }
            catch
            {
            }
            mutex.Dispose();
        }
    }
}
