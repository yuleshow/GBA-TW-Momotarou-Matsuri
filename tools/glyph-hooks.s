.syntax unified
.cpu arm7tdmi
.thumb
.section .text.hooks,"ax",%progbits
.global menu_glyph_hook
.thumb_func
menu_glyph_hook:
    push {r0, r2-r7, lr}
    movs r0, r4
    movs r1, r2
    mov r2, r8
    bl chinese_tile
    movs r1, r0
    pop {r0, r2-r7}
    pop {r3}
    mov lr, r3
    mov r3, r8
    bx lr


.global sjis_glyph_hook
.thumb_func
sjis_glyph_hook:
    push {r0, r2-r7, lr}
    movs r0, r5
    movs r1, r2
    mov r2, r8
    bl chinese_tile
    movs r1, r0
    pop {r0, r2-r7}
    pop {r3}
    mov lr, r3
    mov r3, r8
    bx lr

.ifdef LARGE_UI
.global native_label_hook
.thumb_func
native_label_hook:
    lsls r1, r1, #1
    subs r1, #1
    ldr r3, =0x0803d489
    bx r3

.global native_cursor_hook
.thumb_func
native_cursor_hook:
    push {r4}
    movs r4, #2
    str r4, [sp, #16]
    pop {r4}
    push {r4}
    ldr r4, =0x08046ddd
    mov ip, r4
    pop {r4}
    bx ip

.global native_start_window
.thumb_func
native_start_window:
    movs r0, #5
    movs r1, #12
    movs r2, #20
    movs r3, #8
    push {r4}
    ldr r4, =0x08046a9d
    mov ip, r4
    pop {r4}
    bx ip

.global native_item_window
.thumb_func
native_item_window:
    subs r3, #2
    lsls r3, r3, #1
    adds r3, #2
    push {r4}
    ldr r4, =0x08046a9d
    mov ip, r4
    pop {r4}
    bx ip
.global native_target_window
.thumb_func
native_target_window:
    movs r1, #5
    movs r2, #9
    movs r3, #10
    push {r4}
    ldr r4, =0x08046a9d
    mov ip, r4
    pop {r4}
    bx ip
.endif
