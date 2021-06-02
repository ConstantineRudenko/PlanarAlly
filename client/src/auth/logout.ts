import { defineComponent } from "@vue/runtime-core";

import { postFetch } from "../core/utils";
import { coreStore } from "../store/core";

export const Logout = defineComponent({
    name: "Logout",
    async beforeRouteEnter(_to, _from, next) {
        await postFetch("/api/logout");
        coreStore.setAuthenticated(false);
        coreStore.setUsername("");
        next({ path: "/auth/login" });
    },
});
