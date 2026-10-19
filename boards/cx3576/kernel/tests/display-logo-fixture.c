/* Controlled kernel services for the source-extracted display regression. */
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <linux/linux_logo.h>

typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
#define __read_mostly
#define EXPORT_SYMBOL(...)
#define GFP_KERNEL 0
#define kmalloc(size, flags) malloc(size)
#define kmalloc_array(n, size, flags) calloc(n, size)
#define kzalloc(size, flags) calloc(1, size)
#define array3_size(a, b, c) ((a) * (b) * (c))
#define DIV_ROUND_UP(a, b) (((a) + (b) - 1) / (b))
#define min(a, b) ((a) < (b) ? (a) : (b))
#define kfree(ptr) free(ptr)
#define num_online_cpus() 8
#define min_t(type, a, b) ((type)(a) < (type)(b) ? (type)(a) : (type)(b))
#define swap(a, b) do { __typeof__(a) tmp = (a); (a) = (b); (b) = tmp; } while (0)
#define FB_ROTATE_UR 0
#define FB_ROTATE_CW 1
#define FB_ROTATE_UD 2
#define FB_ROTATE_CCW 3
#define FB_VISUAL_MONO01 0
#define FB_VISUAL_MONO10 1
#define FB_VISUAL_TRUECOLOR 2
#define FB_VISUAL_PSEUDOCOLOR 3
#define FB_VISUAL_DIRECTCOLOR 4
#define FB_VISUAL_STATIC_PSEUDOCOLOR 5
#define FBINFO_STATE_RUNNING 0
#define FBINFO_MISC_TILEBLITTING 1
#define FBINFO_MISC_ALWAYS_SETPAR 2
#define FB_TYPE_TEXT 3
#define FB_ACTIVATE_NOW 0
#define FB_VMODE_MASK 255
#define FB_BLANK_UNBLANK 0
#define KD_TEXT 0
#define KD_GRAPHICS 1
#define FBCON_LOGO_CANSHOW -1
#define FBCON_LOGO_DRAW -2
#define FBCON_LOGO_DONTSHOW -3
#define SCROLL_WRAP_MOVE 1
#define SCROLL_PAN_MOVE 2
#define SCROLL_PAN_REDRAW 3
#define FBCON_SWAP(rotate, a, b) ((rotate) & 1 ? (b) : (a))
#define KERN_ERR ""
#define KERN_INFO ""
#define printk(...) fprintf(stderr, __VA_ARGS__)

struct fb_bitfield { int offset, length; };
struct fb_var_screeninfo {
    unsigned xres, yres, xres_virtual, yres_virtual;
    int activate, vmode, xoffset, yoffset;
    struct fb_bitfield red, green, blue;
};
struct fb_fix_screeninfo { int visual, type; };
struct fb_image { unsigned dx, dy, width, height, depth; const u8 *data; };
struct fb_cmap { int start, len; u16 *red, *green, *blue, *transp; };
struct fb_info;
struct vc_data;
struct fb_ops {
    void *owner;
    int (*fb_set_par)(struct fb_info *);
    void (*fb_imageblit)(struct fb_info *, const struct fb_image *);
};
struct fbcon_ops {
    int currcon, rotate, blank_state, cursor_reset, graphics;
    struct fb_var_screeninfo var;
    int (*rotate_font)(struct fb_info *, struct vc_data *);
    void (*update_start)(struct fb_info *);
};
struct fb_info {
    struct fb_var_screeninfo var;
    struct fb_fix_screeninfo fix;
    struct fb_ops *fbops;
    struct fbcon_ops *fbcon_par;
    void *pseudo_palette;
    int state, flags;
};
struct vc_data {
    unsigned vc_num, vc_top, vc_bottom, vc_rows, vc_cols;
    int vc_mode, vc_can_do_color, vc_complement_mask;
    unsigned vc_video_erase_char, vc_screenbuf_size, vc_size_row;
    unsigned long vc_origin;
    unsigned long vc_pos;
    struct { unsigned x, y; } state;
    struct { unsigned height, width, charcount; } vc_font;
};
struct fbcon_display { int vrows, yscroll; struct fb_var_screeninfo var; };
static struct fb_info screen;
static struct vc_data consoles[2];
static struct { struct vc_data *d; } vc_cons[2];
static struct fbcon_display fb_display[2];
static struct fb_info *fbcon_registered_fb[1] = { &screen };
#define fbcon_for_each_registered_fb(i) for (i = 0; i < 1; ++i)
static unsigned short cells[2][32768];
static int fg_console, logo_shown = FBCON_LOGO_CANSHOW, logo_lines;
static int first_fb_vc = 0, last_fb_vc = 1;
static int scrollback_phys_max, scrollback_max, scrollback_current;
static int color_table[16], draws, clears, text_redraws, failures, updates;
static unsigned last_x, last_y;
static bool fb_center_logo = true;
static int fb_logo_count = 1;
static bool console_locked, info_locked;

static void check(bool condition, const char *name)
{
    printf("%s %s\n", condition ? "PASS" : "FAIL", name);
    failures += !condition;
}
static void blit(struct fb_info *info, const struct fb_image *image)
{
    assert(image->dx + image->width <= info->var.xres);
    assert(image->dy + image->height <= info->var.yres);
    assert(image->width == 720 && image->height == 405);
    assert(image->data == logo_linux_clut224.data);
    assert(info->pseudo_palette);
    /* Read the real generated artwork and converted palette under ASan. */
    for (unsigned i = 0; i < image->width * image->height; ++i) {
        unsigned pixel = image->data[i];
        assert(pixel >= 32 && pixel < 32 + logo_linux_clut224.clutsize);
        volatile u32 color = ((u32 *)info->pseudo_palette)[pixel];
        (void)color;
    }
    last_x = image->dx;
    last_y = image->dy;
    draws++;
}
static void fb_set_cmap(struct fb_cmap *cmap, struct fb_info *info) {}
/* VENDOR_RENDERER */

static struct fb_info *fbcon_info_from_console(int num) { return &screen; }
static bool con_is_visible(struct vc_data *vc) { return vc->vc_num == fg_console; }
static bool fbcon_is_inactive(struct vc_data *vc, struct fb_info *info)
{
    return info->state != FBINFO_STATE_RUNNING || vc->vc_mode != KD_TEXT ||
           info->fbcon_par->graphics;
}
static unsigned short scr_readw(const unsigned short *p) { return *p; }
static void scr_memsetw(unsigned short *p, unsigned short value, unsigned count)
{
    for (unsigned i = 0; i < count / 2; ++i) p[i] = value;
}
#define scr_memcpyw(dst, src, count) memcpy(dst, src, count)
static void display_to_var(struct fb_var_screeninfo *var, struct fbcon_display *p) { *var = p->var; }
static void var_to_display(struct fbcon_display *p, struct fb_var_screeninfo *var, struct fb_info *info) { p->var = *var; }
static int fb_set_var(struct fb_info *info, struct fb_var_screeninfo *var) { info->var = *var; return 0; }
static void fbcon_del_cursor_work(struct fb_info *info) {}
static void fbcon_add_cursor_work(struct fb_info *info) {}
static void set_blitting_type(struct vc_data *vc, struct fb_info *info) {}
static void updatescrollmode(struct fbcon_display *p, struct fb_info *info, struct vc_data *vc) {}
static int fb_scrollmode(struct fbcon_display *p) { return 0; }
static void fbcon_set_palette(struct vc_data *vc, int *table) {}
static void fbcon_clear_margins(struct vc_data *vc, int bottom_only) {}
static void fbcon_clear(struct vc_data *vc, int y, int x, int height, int width) { clears++; }
static void update_region(struct vc_data *vc, unsigned long start, unsigned count) { text_redraws++; }
static void update_start(struct fb_info *info) {}
static void vc_resize(struct vc_data *vc, int cols, int rows)
{
    assert(cols * rows <= 32768);
    vc->vc_cols = cols;
    vc->vc_rows = vc->vc_bottom = rows;
    vc->vc_size_row = cols * 2;
    vc->vc_screenbuf_size = cols * rows * 2;
}
static int fbcon_switch(struct vc_data *vc);
static void update_screen(struct vc_data *vc)
{
    assert(console_locked);
    if (fbcon_switch(vc) && vc->vc_mode != KD_GRAPHICS)
        text_redraws++;
}
static void fbcon_update_vcs(struct fb_info *info, bool all);
static void fbcon_prepare_logo(struct vc_data *vc, struct fb_info *info,
                               int cols, int rows, int new_cols, int new_rows);

struct drm_display_mode { unsigned hdisplay, vdisplay; };
struct drm_mode_set {
    unsigned num_connectors, x, y;
    void *crtc;
    struct drm_display_mode *mode;
};
struct drm_client_dev { int modeset_mutex; struct drm_mode_set modesets[2]; };
struct drm_fb_helper {
    struct fb_info *fbdev;
    struct drm_client_dev client;
    bool delayed_hotplug;
    int lock;
};
struct rockchip_drm_private { struct drm_fb_helper *fbdev_helper; bool loader_protect; };
struct drm_device { void *dev_private; struct { bool poll_enabled; } mode_config; };
#define drm_client_for_each_modeset(modeset, client) \
    for (assert((client)->modeset_mutex), modeset = (client)->modesets; modeset->crtc; modeset++)
static void console_lock(void) { assert(!console_locked); console_locked = true; }
static void console_unlock(void) { assert(console_locked && !info_locked); console_locked = false; }
static void lock_fb_info(struct fb_info *info) { assert(console_locked && !info_locked); info_locked = true; }
static void unlock_fb_info(struct fb_info *info) { assert(info_locked); info_locked = false; }
static void mutex_lock(int *lock) { assert(!*lock); *lock = 1; }
static void mutex_unlock(int *lock) { assert(*lock); *lock = 0; }
static bool attach = true, master;
static int hpd_calls, hpd_error;
static int drm_fb_helper_hotplug_event(struct drm_fb_helper *helper)
{
    assert(!console_locked);
    hpd_calls++;
    if (hpd_error) return hpd_error;
    /* Pinned helper defers first setup without a mode, and defers to a master. */
    helper->delayed_hotplug = master;
    if (attach && !master && !helper->fbdev) {
        helper->fbdev = &screen;
        console_lock();
        struct vc_data *vc = &consoles[fg_console];
        fbcon_prepare_logo(vc, &screen, vc->vc_cols, vc->vc_rows,
                           vc->vc_cols, vc->vc_rows);
        update_screen(vc);
        console_unlock();
    }
    helper->client.modesets[0].num_connectors = attach ? 1 : 0;
    return 0;
}
/* VENDOR_REDRAW */

static struct fbcon_ops ops = { .currcon = -1, .update_start = update_start };
static struct fb_ops fbops = { .fb_imageblit = blit };
static void reset(unsigned width, unsigned height)
{
    screen = (struct fb_info) {
        .var = { .xres = width, .yres = height, .xres_virtual = 1920, .yres_virtual = 1080,
                 .red = {16, 8}, .green = {8, 8}, .blue = {0, 8} },
        .fix = { .visual = FB_VISUAL_TRUECOLOR }, .fbops = &fbops, .fbcon_par = &ops
    };
    for (int i = 0; i < 2; ++i) {
        consoles[i] = (struct vc_data) {
            .vc_num = i, .vc_mode = KD_TEXT, .vc_video_erase_char = 0x720,
            .vc_origin = (unsigned long)cells[i],
            .vc_font = { .height = 16, .width = 8, .charcount = 256 }
        };
        vc_resize(&consoles[i], width / 8, height / 16);
        vc_cons[i].d = &consoles[i];
        fb_display[i].var = screen.var;
        for (unsigned j = 0; j < 32768; ++j) cells[i][j] = 0x720;
    }
    fg_console = 0;
    ops.currcon = 0;
    ops.graphics = ops.blank_state = ops.rotate = 0;
    logo_shown = FBCON_LOGO_CANSHOW;
    draws = clears = text_redraws = updates = hpd_calls = 0;
    fb_logo_count = 1;
    attach = true;
    master = false;
    hpd_error = 0;
}
static void switch_to(int num)
{
    fg_console = num;
    console_lock();
    update_screen(&consoles[num]);
    console_unlock();
}
int main(void)
{
    check(fb_find_logo(24) == &logo_linux_clut224, "artwork selectable after late init");
    const unsigned sizes[][2] = {{800, 600}, {1280, 720}, {1920, 1080}};
    for (unsigned i = 0; i < 3; ++i) {
        reset(sizes[i][0], sizes[i][1]);
        switch_to(0);
        check(draws == 1 && clears == 1 && !text_redraws &&
              last_x == (sizes[i][0] - 720) / 2 && last_y == (sizes[i][1] - 405) / 2,
              "one centered logo on idle tty1, independent of eight online CPUs");
        cells[1][0] = 'L';
        int before = draws;
        switch_to(1);
        check(draws == before && text_redraws >= 1 && cells[1][0] == 'L', "tty2 keeps login/diagnostics");
        switch_to(0);
        check(draws == before + 1 && !consoles[0].vc_top, "VT return restores logo without reserved text rows");
    }
    reset(1920, 1080);
    cells[0][0] = 'E';
    switch_to(0);
    check(!draws && text_redraws == 1, "tty1 diagnostics take precedence");
    reset(1920, 1080);
    consoles[0].vc_mode = KD_GRAPHICS;
    switch_to(0);
    check(!draws && !text_redraws, "graphics VT is not painted");
    reset(1920, 1080);
    ops.blank_state = 1;
    switch_to(0);
    check(!draws, "blanked display is not painted");
    reset(1920, 1080);
    screen.state = 1;
    switch_to(0);
    check(!draws, "suspended framebuffer is not painted");
    reset(1920, 1080);
    fb_logo_count = 0;
    switch_to(0);
    check(!draws, "explicitly disabled logo remains disabled");
    reset(640, 480);
    switch_to(0);
    check(!draws && text_redraws == 1, "too-small mode retains normal text handling");
    reset(1920, 1080);
    fg_console = 1;
    cells[1][0] = 'L';
    console_lock();
    fbcon_prepare_logo(&consoles[1], &screen, 240, 67, 240, 67);
    console_unlock();
    check(logo_shown != FBCON_LOGO_DRAW && !consoles[1].vc_top && cells[1][0] == 'L',
          "initial framebuffer takeover on tty2 never reserves or overwrites login rows");

    reset(1920, 1080);
    struct drm_display_mode mode = {1920, 1080};
    struct drm_fb_helper helper = { .client.modesets = {{ .crtc = &screen, .mode = &mode }} };
    struct rockchip_drm_private private = { .fbdev_helper = &helper };
    struct drm_device dev = { .dev_private = &private, .mode_config.poll_enabled = true };
    attach = false;
    rockchip_drm_output_poll_changed(&dev);
    check(!helper.fbdev && !draws, "headless boot leaves deferred fbdev untouched");
    attach = true;
    rockchip_drm_output_poll_changed(&dev);
    check(helper.fbdev && draws >= 1, "late attach creates framebuffer and paints retained artwork");
    draws = 0;
    attach = false;
    rockchip_drm_output_poll_changed(&dev);
    check(!draws, "detach does not force display activation");
    attach = true;
    mode = (struct drm_display_mode){800, 600};
    rockchip_drm_output_poll_changed(&dev);
    check(draws == 1 && screen.var.xres == 800 && screen.var.yres == 600 &&
          last_x == 40 && last_y == 97, "reattach redraw uses negotiated viewport in reused framebuffer");
    switch_to(1);
    draws = 0;
    text_redraws = 0;
    cells[1][0] = 'L';
    rockchip_drm_output_poll_changed(&dev);
    check(!draws && text_redraws && fg_console == 1 && cells[1][0] == 'L', "hotplug preserves active tty2");
    switch_to(0);
    check(draws == 1 && last_x == 40 && last_y == 97, "return after tty2 hotplug restores centered logo");
    draws = 0;
    master = true;
    rockchip_drm_output_poll_changed(&dev);
    check(!draws && helper.delayed_hotplug, "DRM master retains ownership");
    master = false;
    hpd_error = -1;
    rockchip_drm_output_poll_changed(&dev);
    check(!draws, "failed hotplug setup does not redraw");
    hpd_error = 0;
    helper.client.modesets[0].mode = NULL;
    rockchip_drm_output_poll_changed(&dev);
    check(!draws, "missing negotiated mode is not invented");
    helper.client.modesets[0].mode = &mode;
    mode = (struct drm_display_mode){3840, 2160};
    unsigned old_width = screen.var.xres, old_height = screen.var.yres;
    rockchip_drm_output_poll_changed(&dev);
    check(!draws && screen.var.xres == old_width && screen.var.yres == old_height,
          "viewport cannot exceed backing allocation");
    private.loader_protect = true;
    int calls = hpd_calls;
    rockchip_drm_output_poll_changed(&dev);
    check(hpd_calls == calls, "firmware loader protection preserved");
    private.loader_protect = false;
    dev.mode_config.poll_enabled = false;
    rockchip_drm_output_poll_changed(&dev);
    check(hpd_calls == calls, "disabled polling remains inactive");
    private.fbdev_helper = NULL;
    dev.mode_config.poll_enabled = true;
    rockchip_drm_output_poll_changed(&dev);
    check(hpd_calls == calls, "absent helper is safe");
    printf("display fixture: %d failures\n", failures);
    return failures != 0;
}
