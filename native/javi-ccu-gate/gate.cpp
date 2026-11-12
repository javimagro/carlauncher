// Interposition and rotary continuity follow the MIT-licensed mgu-inputgate.
// See LICENSE-inputgate.txt.
#include <vsomeip/message.hpp>
#include <vsomeip/payload.hpp>

#include <dlfcn.h>
#include <pthread.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "frontccu-filter.h"

namespace {

constexpr char leaseFile[] = "/run/javi-carlab/frontccu.lease";
constexpr char receiveName[] = "_ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE";
using Receive = void (*)(void *, const std::shared_ptr<vsomeip::message> &);
Receive receive;
bool hmiProcess;
pthread_once_t initialize = PTHREAD_ONCE_INIT;
pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
frontccu::Filter filter;

void resolve() {
    receive = reinterpret_cast<Receive>(dlsym(RTLD_NEXT, receiveName));
    if (!receive) {
        // CommonAPI can load the transport in a local dynamic-linker scope.
        void *transport = dlopen("libCommonAPI-SomeIP.so.3.1.12", RTLD_LAZY | RTLD_NOLOAD);
        if (transport) receive = reinterpret_cast<Receive>(dlsym(transport, receiveName));
    }
    char exe[4096];
    const auto length = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (length <= 0 || length == sizeof exe - 1) return;
    exe[length] = '\0';
    const auto name = strrchr(exe, '/');
    hmiProcess = name && strcmp(name + 1, "Hmi8") == 0;
}

bool capture() {
    struct stat info;
    if (lstat(leaseFile, &info) || !S_ISREG(info.st_mode) || info.st_uid != 0 || (info.st_mode & 0022)) return false;
    timespec now;
    if (clock_gettime(CLOCK_REALTIME, &now)) return false;
    if (now.tv_sec - info.st_mtim.tv_sec > 1 || now.tv_sec < info.st_mtim.tv_sec) return false;
    return frontccu::leaseFresh((now.tv_sec - info.st_mtim.tv_sec) * 1000000000LL + now.tv_nsec - info.st_mtim.tv_nsec);
}

} // namespace

extern "C" __attribute__((visibility("default")))
void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *self, const std::shared_ptr<vsomeip::message> &message) {
    pthread_once(&initialize, resolve);
    if (!receive) return;
    if (!hmiProcess || !message || message->get_service() != frontccu::service ||
        message->get_instance() != frontccu::instance || message->get_message_type() != vsomeip::message_type_e::MT_NOTIFICATION) {
        receive(self, message);
        return;
    }
    const auto event = message->get_method();
    const auto length = frontccu::payloadSize(event);
    const auto payload = length ? message->get_payload() : nullptr;
    if (!payload || payload->get_length() != length || !payload->get_data()) {
        receive(self, message);
        return;
    }

    // The verified transport delivers notifications synchronously to its event listeners.
    uint8_t *data = payload->get_data();
    uint8_t original[8];
    memcpy(original, data, length);
    pthread_mutex_lock(&mutex);
    filter.apply(event, data, capture());
    pthread_mutex_unlock(&mutex);
    receive(self, message);
    memcpy(data, original, length);
}
