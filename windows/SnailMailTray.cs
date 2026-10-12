using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Runtime.InteropServices;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
        string node = "node.exe";
        string command = "";
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--root" && i + 1 < args.Length) root = Path.GetFullPath(args[++i]);
            else if (args[i] == "--node" && i + 1 < args.Length) node = args[++i];
            else if (args[i] == "--quit" || args[i] == "--restart") command = args[i];
            else return 2;
        }
        string identity;
        using (var sha = SHA256.Create())
            identity = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(
                root.ToLowerInvariant() + WindowsIdentity.GetCurrent().User.Value))).Replace("-", "").Substring(0, 24);
        string name = @"Local\SnailMailTray-" + identity;
        if (command != "")
        {
            EventWaitHandle signal;
            if (!EventWaitHandle.TryOpenExisting(name + command, out signal)) return 3;
            using (signal) signal.Set();
            return 0;
        }
        bool created;
        using (var single = new Mutex(true, name, out created))
        {
            if (!created) return 0;
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var context = new TrayContext(root, node, name)) Application.Run(context);
                return 0;
            }
            catch (Exception ex)
            {
                Directory.CreateDirectory(Path.Combine(root, "data"));
                File.AppendAllText(Path.Combine(root, "data", "tray.log"), DateTime.UtcNow.ToString("o") + " " + ex + Environment.NewLine);
                return 1;
            }
            finally { single.ReleaseMutex(); }
        }
    }
}

internal sealed class TrayContext : ApplicationContext
{
    private readonly string root, node, data, localUrl;
    private readonly NotifyIcon tray;
    private readonly Icon icon;
    private readonly ContextMenuStrip menu;
    private readonly ToolStripMenuItem status, restart;
    private readonly System.Windows.Forms.Timer timer;
    private readonly EventWaitHandle quitSignal, restartSignal;
    private readonly JavaScriptSerializer json = new JavaScriptSerializer();
    private readonly object logLock = new object();
    private Process server;
    private bool quitting, checking, external;
    private int failures;
    private DateTime retryAt = DateTime.MinValue;
    private DateTime nextCheck = DateTime.MinValue;
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();

    public TrayContext(string root, string node, string name)
    {
        this.root = root;
        this.node = node;
        data = Path.Combine(root, "data");
        Directory.CreateDirectory(data);
        var config = json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(
            File.ReadAllText(Path.Combine(data, "config.json")));
        int port = config.ContainsKey("port") ? Convert.ToInt32(config["port"]) : 4318;
        if (port < 1 || port > 65535) throw new Exception("Invalid server port");
        localUrl = "http://127.0.0.1:" + port;
        if (!File.Exists(Path.Combine(root, "server", "index.mjs"))) throw new Exception("Server file missing");
        quitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, name + "--quit");
        restartSignal = new EventWaitHandle(false, EventResetMode.AutoReset, name + "--restart");
        icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        menu = new ContextMenuStrip();
        status = new ToolStripMenuItem("Starting server…") { Enabled = false };
        menu.Items.Add(status);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Open mailbox", null, delegate { Open(localUrl); });
        restart = new ToolStripMenuItem("Restart server", null, delegate { Restart(); });
        menu.Items.Add(restart);
        menu.Items.Add("View server log", null, delegate { OpenLog("service.log"); });
        menu.Items.Add("View tray log", null, delegate { OpenLog("tray.log"); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit and stop server", null, delegate { ExitThread(); });
        tray = new NotifyIcon { Icon = icon, Text = "Snail Mail — starting", ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { Open(localUrl); };
        // No Form and no console are created. The message loop belongs to the tray.
        timer = new System.Windows.Forms.Timer { Interval = 500 };
        timer.Tick += Tick;
        timer.Start();
        Log("Tray started; console attached=" + (GetConsoleWindow() != IntPtr.Zero));
    }

    private void Log(string message)
    {
        WriteLog("tray.log", DateTime.UtcNow.ToString("o") + " " + message);
    }
    private void WriteLog(string filename, string line)
    {
        if (line == null) return;
        lock (logLock)
        {
            try
            {
                string path = Path.Combine(data, filename);
                if (File.Exists(path) && new FileInfo(path).Length > 2 * 1024 * 1024)
                {
                    File.Copy(path, path + ".previous", true);
                    File.WriteAllText(path, "");
                }
                File.AppendAllText(path, line + Environment.NewLine);
            }
            catch (IOException) { }
        }
    }
    private void SetStatus(string text)
    {
        status.Text = text;
        tray.Text = "Snail Mail — " + text;
        restart.Enabled = !external && !quitting;
        var snapshot = new {
            trayPid = Process.GetCurrentProcess().Id,
            serverPid = server != null && !server.HasExited ? (int?)server.Id : null,
            state = text, consoleAttached = GetConsoleWindow() != IntPtr.Zero,
            checkedAt = DateTime.UtcNow.ToString("o")
        };
        try
        {
            string path = Path.Combine(data, "tray-status.json");
            File.WriteAllText(path + ".tmp", json.Serialize(snapshot));
            if (File.Exists(path)) File.Replace(path + ".tmp", path, null);
            else File.Move(path + ".tmp", path);
        }
        catch (IOException ex) { Log("Could not record tray status: " + ex.Message); }
    }
    private bool Healthy()
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(localUrl + "/api/health");
            req.Timeout = 1500;
            req.ReadWriteTimeout = 1500;
            req.Proxy = null;
            using (var response = req.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                var health = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(reader.ReadToEnd());
                return health.ContainsKey("ok") && health["ok"] is bool && (bool)health["ok"];
            }
        }
        catch { return false; }
    }
    private async void Tick(object sender, EventArgs args)
    {
        if (quitting) return;
        if (quitSignal.WaitOne(0)) { ExitThread(); return; }
        if (restartSignal.WaitOne(0)) { Restart(); return; }
        if (checking || DateTime.UtcNow < nextCheck) return;
        checking = true;
        try
        {
            bool healthy = await Task.Run((Func<bool>)Healthy);
            if (quitting) return;
            if (server != null && server.HasExited)
            {
                Log("Server exited with code " + server.ExitCode);
                server.Dispose(); server = null;
                failures++;
                retryAt = DateTime.UtcNow.AddSeconds(Math.Min(60, failures * 5));
            }
            if (server == null && healthy)
            {
                external = true;
                SetStatus("Server running outside tray");
            }
            else if (server == null && failures >= 5)
            {
                external = false;
                SetStatus("Server stopped — restart to retry");
            }
            else if (server == null && DateTime.UtcNow >= retryAt)
            {
                external = false;
                StartServer();
            }
            else if (server == null)
            {
                external = false;
                SetStatus("Restarting server soon");
            }
            else
            {
                external = false;
                if (healthy) failures = 0;
                SetStatus(healthy ? "Server running" : "Server not responding");
            }
        }
        catch (Exception ex)
        {
            Log("Server check failed: " + ex.Message);
            failures++;
            retryAt = DateTime.UtcNow.AddSeconds(10);
            SetStatus("Server needs attention");
        }
        finally { checking = false; nextCheck = DateTime.UtcNow.AddSeconds(5); }
    }
    private void StartServer()
    {
        var info = new ProcessStartInfo(node, "\"" + Path.Combine(root, "server", "index.mjs") + "\"") {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true,
            RedirectStandardError = true, RedirectStandardInput = true
        };
        info.EnvironmentVariables["SNAIL_TRAY_MANAGED"] = "1";
        // Use this installation's configured database/port even if a developer shell
        // launching the tray happened to export test overrides.
        info.EnvironmentVariables.Remove("SNAIL_DATA_DIR");
        info.EnvironmentVariables.Remove("PORT");
        var child = new Process { StartInfo = info };
        child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog("service.log", e.Data); };
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { WriteLog("service.log", e.Data); };
        try { child.Start(); }
        catch { child.Dispose(); throw; }
        server = child;
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
        Log("Started hidden server PID " + server.Id);
        SetStatus("Starting server");
    }
    private void StopServer()
    {
        if (server == null) return;
        try
        {
            if (!server.HasExited)
            {
                try { server.StandardInput.WriteLine("snail-mail:shutdown"); server.StandardInput.Flush(); }
                catch (IOException) { }
                if (!server.WaitForExit(5000)) { server.Kill(); server.WaitForExit(2000); }
            }
            Log("Stopped managed server");
        }
        catch (Exception ex) { Log("Stop failed: " + ex.Message); }
        finally { server.Dispose(); server = null; }
    }
    private void Restart()
    {
        if (quitting || external) return;
        StopServer();
        failures = 0; retryAt = DateTime.MinValue; nextCheck = DateTime.MinValue;
        SetStatus("Restarting server");
    }
    private void Open(string target)
    {
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch (Exception ex) { Log("Open failed: " + ex.Message); }
    }
    private void OpenLog(string filename)
    {
        string path = Path.Combine(data, filename);
        if (!File.Exists(path)) File.WriteAllText(path, "");
        try { Process.Start(new ProcessStartInfo("notepad.exe", "\"" + path + "\"") { UseShellExecute = true }); }
        catch (Exception ex) { Log("Open log failed: " + ex.Message); }
    }
    protected override void ExitThreadCore()
    {
        if (quitting) return;
        quitting = true;
        timer.Stop();
        StopServer();
        SetStatus("Stopped");
        tray.Visible = false;
        Log("Tray exited");
        base.ExitThreadCore();
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            if (!quitting) ExitThreadCore();
            timer.Dispose(); tray.Dispose(); menu.Dispose(); icon.Dispose();
            quitSignal.Dispose(); restartSignal.Dispose();
        }
        base.Dispose(disposing);
    }
}
