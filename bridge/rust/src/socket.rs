use std::{io, net::TcpListener};
#[cfg(windows)]
struct WinSockSession;
#[cfg(windows)]
impl Drop for WinSockSession {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Networking::WinSock::WSACleanup();
        }
    }
}
pub struct ExclusiveSocket {
    listener: TcpListener,
    #[cfg(windows)]
    _winsock: WinSockSession,
}
impl ExclusiveSocket {
    #[cfg(windows)]
    pub fn reserve(port: u16) -> io::Result<Self> {
        use std::{mem::size_of, os::windows::io::FromRawSocket};
        use windows_sys::Win32::Networking::WinSock::*;
        let mut data = WSADATA::default();
        let code = unsafe { WSAStartup(0x202, &mut data) };
        if code != 0 {
            return Err(io::Error::from_raw_os_error(code));
        }
        let winsock = WinSockSession;
        let raw = unsafe {
            WSASocketW(
                AF_INET as i32,
                SOCK_STREAM,
                IPPROTO_TCP,
                std::ptr::null(),
                0,
                WSA_FLAG_NO_HANDLE_INHERIT,
            )
        };
        if raw == INVALID_SOCKET {
            return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
        }
        let enabled = 1i32;
        let address = SOCKADDR_IN {
            sin_family: AF_INET,
            sin_port: port.to_be(),
            sin_addr: IN_ADDR {
                S_un: IN_ADDR_0 {
                    S_addr: u32::from_ne_bytes([127, 0, 0, 1]),
                },
            },
            sin_zero: [0; 8],
        };
        let ok = unsafe {
            setsockopt(
                raw,
                SOL_SOCKET,
                SO_EXCLUSIVEADDRUSE,
                (&enabled as *const i32).cast(),
                size_of::<i32>() as i32,
            )
        } == 0
            && unsafe {
                bind(
                    raw,
                    (&address as *const SOCKADDR_IN).cast(),
                    size_of::<SOCKADDR_IN>() as i32,
                )
            } == 0;
        if !ok {
            let error = unsafe { WSAGetLastError() };
            unsafe {
                closesocket(raw);
            }
            return Err(io::Error::from_raw_os_error(error));
        }
        // TcpListener owns the non-inheritable bound socket; listening is explicit at the HTTP layer.
        Ok(Self {
            listener: unsafe { TcpListener::from_raw_socket(raw as _) },
            _winsock: winsock,
        })
    }
    #[cfg(not(windows))]
    pub fn reserve(_: u16) -> io::Result<Self> {
        Err(io::Error::other("Windows exclusive sockets required"))
    }
    pub fn port(&self) -> io::Result<u16> {
        Ok(self.listener.local_addr()?.port())
    }
    pub fn listen(&self) -> io::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawSocket;
            use windows_sys::Win32::Networking::WinSock::*;
            if unsafe { listen(self.listener.as_raw_socket() as _, SOMAXCONN as i32) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
    pub fn listener(&self) -> &TcpListener {
        &self.listener
    }
    pub fn http_listener(&self) -> io::Result<TcpListener> {
        self.listen()?;
        let listener = self.listener.try_clone()?;
        // Tokio must receive a nonblocking handle after Windows socket duplication.
        listener.set_nonblocking(true)?;
        Ok(listener)
    }
}
