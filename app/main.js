// Modules to control application life and create native browser window
const {app, BrowserWindow, Menu, Tray, dialog, Notification, ipcMain} = require('electron');
const path = require('path'), fs = require('fs-extra')

process.on('uncaughtException', function (error) {
    // Handle the error
    dialog.showErrorBox("出现错误，程序退出", error.stack || "");
    app.exit(-2);
})

const libPath = path.join(process.resourcesPath, 'lib.asar');
const requireLib = (module) => require(path.join(libPath, 'node_modules', module));

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow, topWindow;
let child;

ipcMain.on('asynchronous-message', (event, arg) => {
    console.log(arg); // prints "ping"
    event.sender.send('asynchronous-reply', 'pong2')
})

let a = 0;
ipcMain.on('synchronous-message', (event, arg) => {
    a++;
    mainWindow.setProgressBar(a / 100);
    console.log(arg) // prints "ping"
    event.returnValue = dialog.showOpenDialog({
        title: '选择魔兽执行文件',
        properties: ['openDirectory'],
        filters: [{name: 'exe', extensions: ['exe']}]
    }) || 'null';
    //event.returnValue = a;
})

let lastPromptRestart = 0;

function showRestartDialog() {
    if (Date.now() - lastPromptRestart < 10 * 60 * 1000) return;
    if (Notification.isSupported()) {
        let notification = new Notification({
            title: '发现新版更新器',
            subtitle: 'test',
            body: '已经下载，请重启',
        });
        notification.show();
    }

    let button = dialog.showMessageBox(mainWindow, {
        title: "爱不易更需要重启",
        message: "更新器已在后台下载完毕，重启即可生效，是否确认？",
        type: 'question',
        buttons: ["重启", "稍后"], defaultId: 0, cancelId: 1
    });

    lastPromptRestart = Date.now();
    if (button === 0) {
        app.relaunch({execPath: process.execPath, args: process.argv.slice(1).concat(['--relaunch'])});
        app.exit(0);
    }
}

async function checkUpdateAsar() {

    const {downloadRetry, getGitRawUrl} = require('./utils');

    let releaseJsonUrl = (gitUser, gitRepo, gitHash) => (file, retry) => {
        if (retry < 2) {
            return getGitRawUrl('gitlab', false, gitUser, gitRepo, gitHash, file); //官方稳定，但不能续传
        } else if (retry < 3) {
            return getGitRawUrl('bitbucket', false, gitUser, gitRepo, gitHash, file); //官方能续传，但限制访问
        } else if (retry < 5) {
            return getGitRawUrl('github', false, gitUser, gitRepo, gitHash, file); //hack不限量，不能续传
        } else {
            return undefined;
        }
    };

    function streamPromise(stream, value) {
        return new Promise((resolve, reject) => {
            stream.on('finish', () => resolve(value));
            stream.on('error', reject);
        })
    }

    let dataPath = path.join(path.dirname(process.execPath) + '/data');
    let releaseJsonPath = path.join(dataPath, 'abyui-release.json');
    let releaseJsonTmp = releaseJsonPath + '.remote';
    let gzPath = path.join(process.resourcesPath, 'app.asar.gz');
    let asarPath = path.join(process.resourcesPath, 'app-updated.asar');

    let current = await fs.pathExists(releaseJsonPath).then(() => fs.readJSON(releaseJsonPath)).catch(() => undefined);

    let verElec = process.versions.electron;
    let verApp = app.getVersion(), verLib = fs.readJsonSync(libPath + '/package.json').version;

    console.log('checking update', verElec, 'app', verApp, 'lib', verLib);
    downloadRetry('abyui-release.json', releaseJsonTmp, releaseJsonUrl('aby-ui', 'repo-release', 'master'))
        .then(() => fs.readJSON(releaseJsonTmp))
        .then((remote) => {
            if (!current || current.client.hash !== remote.client.hash) {
                console.log('downloading new client', remote.client.hash);
                return downloadRetry('app.asar.gz', gzPath, (file, retry) => remote.client.app.urls[retry]);
            }
        })
        .then((r) => {
            if (r) {
                console.log('downloaded', r);
                let stream = fs.createReadStream(gzPath).pipe(require('zlib').createGunzip()).pipe(require('original-fs').createWriteStream(asarPath));
                return streamPromise(stream, r);
            }
        })
        .then((r) => {
            if (r) {
                return fs.remove(releaseJsonPath)
                    .then(() => fs.rename(releaseJsonPath + '.remote', releaseJsonPath))
                    .then(() => {
                        console.log('update success');
                        showRestartDialog();
                        return r;
                    })
            }
        })
        .then((r) => {
            if (!r && fs.pathExistsSync(asarPath)) {
                showRestartDialog();
            }
        })
        .then(() => setTimeout(checkUpdateAsar, 5 * 60 * 1000))
        .catch(e => {
            console.error(e)
            setTimeout(checkUpdateAsar, 2 * 60 * 1000)
        });
}

function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({width: 800, height: 600, frame: true});
    // child = new BrowserWindow({modal:true, parent: mainWindow});

    topWindow = new BrowserWindow({modal: true, show: false, alwaysOnTop: false, parent: mainWindow}); //alwaysOnTop会在其他应用的上面

    //mainWindow.webContents.openDevTools();

    mainWindow.webContents.on('did-finish-load', function () {
        if (mainWindow) mainWindow.setProgressBar(0);
    });

    // and load the index.html of the app.
    mainWindow.loadFile('index.html');

    // child.loadFile('index.html');

    // Open the DevTools.
    // mainWindow.webContents.openDevTools()

    // Emitted when the window is closed.
    mainWindow.on('closed', function (e) {
        // Dereference the window object, usually you would store windows
        // in an array if your app supports multi windows, this is the time
        // when you should delete the corresponding element.
        console.log("closed")
        mainWindow = null
    })

    // mainWindow.setClosable(false);
    // mainWindow.setFullScreenable(true);

    mainWindow.on('close', (e) => {
        console.log('on close prevent');
        mainWindow.hide();
        e.preventDefault();
    })

    mainWindow.on('minimize', () => {
        console.log("minimized")
        mainWindow.hide();
    })
}

const isSecondInstance = app.makeSingleInstance((commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore()
            mainWindow.focus()
        } else {
            mainWindow.show()
        }
    }
})

if (isSecondInstance) {
    app.quit()
}


let tray = null
app.on('ready', () => {

    testElectron();

    setTimeout(checkUpdateAsar, 1000);

    let trayIcon = path.join(__dirname, 'searchbox_button.png');
    console.log(trayIcon);
    tray = new Tray(trayIcon)
    const contextMenu = Menu.buildFromTemplate([
        {label: 'Item1', type: 'normal'},
        {
            label: '重启', type: 'normal', click: () => {
                app.relaunch({execPath: 'aaa.bat', args: process.argv.slice(1).concat(['--relaunch'])});
                app.exit(0);
            }
        },
        {
            label: '退出', type: 'normal', click: () => {
                app.exit(0)
            }
        }
    ])
    tray.setToolTip('This is my application.')
    tray.setContextMenu(contextMenu)

    tray.on('click', () => {
        mainWindow.show();
    })
})

// app.commandLine.appendSwitch('remote-debugging-port', '9222');

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed.
app.on('window-all-closed', function () {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
});

app.on('activate', function () {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        createWindow()
    }
});

async function testElectron() {
    dialog.showMessageBox( { message : 'hello' } );
    console.log(fs.readJsonSync(libPath + '/package.json').version);
    console.log(app.getVersion());
    await (requireLib('decompress'))("C:\\code\\lua\\163ui.beta\\fetch-merge.libs\\fm\\AceGUI-3.0-SharedMediaWidgets\\AceGUI-3.0-SharedMediaWidgets-r37.zip", path.join(process.cwd(), '..', 'ttt'));
    console.log(process.execPath, process.cwd());
    if(true) process.exit(0);
}