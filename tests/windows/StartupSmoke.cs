using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Security.Principal;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Xml.Linq;

internal static class StartupSmoke
{
    private static readonly BindingFlags fields = BindingFlags.Instance | BindingFlags.NonPublic;
    private static readonly XNamespace ns = "http://schemas.microsoft.com/windows/2004/02/mit/task";
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static async Task Until(Func<bool> ready)
    {
        var end = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < end) { if (ready()) return; await Task.Delay(100); }
        throw new Exception("Startup test timed out.");
    }
    private static System.Collections.Generic.Dictionary<string, object> Status(string root)
    {
        return new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(
            File.ReadAllText(Path.Combine(root, "data", "tray-status.json")));
    }
    [STAThread]
    private static int Main(string[] args)
    {
        string root = args[0], node = args[1], binary = args[2];
        string taskName = "Snail Mail startup test " + Guid.NewGuid().ToString("N");
        var registration = new StartupRegistration(root, node, binary, taskName);
        int result = 1;
        dynamic scheduler = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service", true));
        scheduler.Connect();
        dynamic folder = scheduler.GetFolder(@"\");
        string original = null;
        try { original = folder.GetTask(StartupRegistration.DefaultTaskName).Xml; }
        catch (Exception ex) { if (ex.HResult != unchecked((int)0x80070002)) throw; }
        try
        {
            Check(!registration.Apply("status"), "Fresh install should start unchecked.");
            Check(!registration.Apply("disable"), "Disabling an absent task should be harmless.");
            Check(registration.Apply("enable"), "Enabling startup did not persist.");
            Check(registration.Apply("enable"), "Repeated enable should be safe.");
            var xml = XDocument.Parse((string)folder.GetTask(taskName).Xml);
            var principal = xml.Root.Element(ns + "Principals").Element(ns + "Principal");
            Check((string)principal.Element(ns + "UserId") == WindowsIdentity.GetCurrent().User.Value, "Wrong startup user.");
            Check((string)principal.Element(ns + "LogonType") == "InteractiveToken", "Must start at interactive sign-in.");
            Check((int)folder.GetTask(taskName).Definition.Principal.RunLevel == 0, "Must not require elevation.");
            Check((string)xml.Root.Element(ns + "Actions").Element(ns + "Exec").Element(ns + "Command") == binary, "Wrong executable.");
            Check(((string)xml.Root.Element(ns + "Actions").Element(ns + "Exec").Element(ns + "Arguments")).Contains(StartupRegistration.QuoteArgument(root)), "Paths containing spaces were not quoted.");
            var collision = new StartupRegistration(root + "-unrelated", node, binary, taskName);
            foreach (string action in new[] { "status", "enable", "disable" })
            {
                bool refused = false;
                try { collision.Apply(action); } catch (InvalidOperationException) { refused = true; }
                Check(refused, "Another installation's task was not protected.");
            }
            Check(registration.Apply("status"), "Collision changed the existing task.");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var context = new TrayContext(root, node, @"Local\" + taskName, registration))
            using (var timer = new System.Windows.Forms.Timer { Interval = 100 })
            {
                var item = (ToolStripMenuItem)typeof(TrayContext).GetField("startup", fields).GetValue(context);
                timer.Tick += async delegate {
                    timer.Stop();
                    try
                    {
                        await Until(() => item.Enabled && item.Checked && File.Exists(Path.Combine(root, "data", "tray-status.json")) && (string)Status(root)["state"] == "Server running");
                        var first = Status(root);
                        Check(!(bool)first["consoleAttached"], "Tray opened a console.");
                        item.PerformClick();
                        await Until(() => item.Enabled && !item.Checked);
                        Check(!registration.Apply("status"), "Tray unchecked without disabling Windows startup.");
                        Check((int)Status(root)["serverPid"] == (int)first["serverPid"], "Changing startup stopped the current server.");
                        item.PerformClick();
                        await Until(() => item.Enabled && item.Checked);
                        Check(registration.Apply("status"), "Tray checked without enabling Windows startup.");
                        registration.Apply("disable");
                        typeof(TrayContext).GetMethod("UpdateStartup", fields).Invoke(context, new object[] { "status" });
                        await Until(() => item.Enabled && !item.Checked);
                        item.PerformClick();
                        await Until(() => item.Enabled && item.Checked);
                        result = 0;
                    }
                    catch (Exception ex) { Console.Error.WriteLine(ex); }
                    finally { context.ExitThread(); }
                };
                timer.Start();
                Application.Run(context);
            }
            Check(registration.Apply("status"), "Quitting unexpectedly disabled startup.");
            Check((string)Status(root)["state"] == "Stopped", "Test server did not stop.");
            if (original != null) Check((string)folder.GetTask(StartupRegistration.DefaultTaskName).Xml == original, "Real startup task changed during test.");
            if (result == 0) Console.WriteLine("Verified native startup enable/disable, tray checkmark, refresh, ownership, silent server, and quit behavior.");
        }
        catch (Exception ex) { Console.Error.WriteLine(ex); result = 1; }
        finally
        {
            try { folder.DeleteTask(taskName, 0); }
            catch (Exception ex) { if (ex.HResult != unchecked((int)0x80070002)) throw; }
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(folder);
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(scheduler);
        }
        return result;
    }
}
